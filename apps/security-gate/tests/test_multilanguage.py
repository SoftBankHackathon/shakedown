"""Language routing, template coverage, mapping, and real web-language scans."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys

import jsonschema
import pytest
import yaml

from security_gate import semgrep, source_targets, source_units
from security_gate.gate3 import scan_full_repository
from test_gitleaks import FAKE, runner as secret_runner, validate
from test_semgrep import output_runner

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "semgrep"


def scan(path, runner=None):
    return validate(scan_full_repository(path, semgrep_runner=runner or output_runner(),
                                        gitleaks_runner=secret_runner()))


def test_bundled_web_rules_use_both_languages_and_known_ids():
    data = yaml.safe_load(semgrep.WEB_RULE_FILE.read_text(encoding="utf-8"))
    assert {r["id"] for r in data["rules"]} == {r for r in semgrep.RULES if "-web-" in r}
    assert all(r["languages"] == ["javascript", "typescript"] for r in data["rules"])


@pytest.mark.parametrize("suffix,language", [(".js", "javascript"), (".jsx", "javascript"),
    (".mjs", "javascript"), (".cjs", "javascript"), (".ts", "typescript"), (".tsx", "typescript"),
    (".mts", "typescript"), (".cts", "typescript")])
def test_web_extensions_pass_real_syntax_preflight(tmp_path, suffix, language):
    (tmp_path / ("app" + suffix)).write_text("const value = 1;", encoding="utf-8")
    report = semgrep.scan_semgrep(tmp_path, runner=output_runner())
    assert report["decision"] == "ALLOW"
    assert report["scanned_languages"] == report["detected_languages"] == [language]
    assert report["scanned_units"] == report["scanned_files"] == 1


def test_all_four_languages_and_missing_unit(tmp_path):
    for language, filename in [("safe", "sample.py"), ("java_safe", "BoardService.java"),
                                ("javascript_safe", "sample.js"), ("typescript_safe", "sample.ts")]:
        shutil.copy(FIXTURES / language / filename, tmp_path)
    report = scan(tmp_path)
    assert report["decision"] == "ALLOW"
    assert report["semgrep"]["scanned_languages"] == ["java", "javascript", "python", "typescript"]
    assert report["semgrep"]["scanned_units"] == 4
    report = scan(tmp_path, output_runner(edit=lambda p: p["paths"]["scanned"].pop()))
    assert report["decision"] == "SCAN_FAILED"
    assert report["semgrep"]["errors"] == ["SEMGREP_INCOMPLETE_SCAN"]


def test_python_ast_still_blocks_invalid_python_in_web_project(tmp_path):
    (tmp_path / "app.js").write_text("const value = 1;", encoding="utf-8")
    (tmp_path / "bad.py").write_text("def broken(", encoding="utf-8")
    assert scan(tmp_path)["semgrep"]["errors"] == ["SOURCE_SYNTAX_INVALID"]


def test_two_scripts_in_one_html_require_two_scanned_units(tmp_path):
    (tmp_path / "index.html").write_text("<script>const a=1;</script>\n<script>const b=2;</script>", encoding="utf-8")
    report = scan(tmp_path)
    assert report["decision"] == "ALLOW"
    assert report["semgrep"]["scanned_files"] == 1
    assert report["semgrep"]["scanned_units"] == 2
    report = scan(tmp_path, output_runner(edit=lambda p: p["paths"]["scanned"].pop()))
    assert report["decision"] == "SCAN_FAILED"
    assert report["semgrep"]["errors"] == ["SEMGREP_INCOMPLETE_SCAN"]
    assert report["semgrep"]["scanned_files"] == report["semgrep"]["scanned_units"] == 1


@pytest.mark.parametrize("source,unit_line,original_line", [
    ("<html>\n<script>\neval(input);\n</script></html>", 2, 3),
    ('<button\n onclick="eval(input)">go</button>', 1, 2),
    ('<button\nonclick="eval(input)">go</button>', 1, 2),
    ('<a\n href="javascript:eval(input)">go</a>', 1, 2),
    ('<button\n th:onclick="eval([[${value}]])">go</button>', 1, 2),
])
def test_template_findings_map_to_original_file_and_line(tmp_path, source, unit_line, original_line):
    path = tmp_path / "page.html"
    path.write_text(source, encoding="utf-8")
    def edit(payload):
        payload["results"] = [{"check_id": "security-gate-web-dynamic-eval", "path": payload["paths"]["scanned"][0],
                               "start": {"line": unit_line}, "extra": {"message": FAKE}}]
    report = scan(tmp_path, output_runner(returncode=1, edit=edit))
    assert report["decision"] == "DENY"
    assert report["findings"][0]["file_path"] == str(path)
    assert report["findings"][0]["line"] == original_line
    assert FAKE not in json.dumps(report)


@pytest.mark.parametrize("source,gap", [
    ('<script src="https://example.invalid/app.js"></script>', "EXTERNAL_SCRIPT_REFERENCE"),
    ('<script src="//example.invalid/app.js"></script>', "EXTERNAL_SCRIPT_REFERENCE"),
    ('<script src="missing.js"></script>', "UNRESOLVED_SCRIPT_REFERENCE"),
    ('<script src="../outside.js"></script>', "UNRESOLVED_SCRIPT_REFERENCE"),
    ('<script th:src="@{/script.js}"></script>', "DYNAMIC_SCRIPT_REFERENCE"),
    ('<script type="text/coffeescript">x = 1</script>', "UNSUPPORTED_SCRIPT_TYPE"),
    ('<script>const x = [[${value}]];</script>', "TEMPLATE_EXPRESSION"),
    ('<script>const x = 1;', "MALFORMED_TEMPLATE"),
    ('<script/>eval(input);', "MALFORMED_TEMPLATE"),
    ('<button onclick="eval(input)" onclick="run()">go</button>', "MALFORMED_TEMPLATE"),
    ('<button th:onclick="${handler}">go</button>', "TEMPLATE_EXPRESSION"),
    ('<script th:utext="${code}">placeholder();</script>', "TEMPLATE_EXPRESSION"),
    ('<script language="vbscript">placeholder()</script>', "UNSUPPORTED_SCRIPT_TYPE"),
])
def test_uninspected_template_content_is_reported_and_only_evasive_forms_block(tmp_path, source, gap):
    (tmp_path / "safe.js").write_text("const value = 1;", encoding="utf-8")
    (tmp_path / "page.html").write_text(source, encoding="utf-8")
    report = scan(tmp_path)
    # An unresolved server-side expression is not valid JavaScript. The new
    # parser fails closed; the coverage gap must still be preserved.
    if source == '<button th:onclick="${handler}">go</button>':
        assert report["decision"] == "SCAN_FAILED"
        assert report["semgrep"]["errors"] == ["SOURCE_SYNTAX_INVALID"]
    elif gap not in source_targets.REPORTED_GAPS:
        assert (report["decision"], report["reason_code"]) == ("DENY", "UNSUPPORTED_SOURCE")
        assert gap in report["semgrep"]["block_reasons"]
    else:
        # CDN·템플릿 표현식처럼 못 본 범위는 막지 않고 보고서에 남긴다.
        assert report["decision"] == "ALLOW"
    assert gap in report["semgrep"]["coverage_gaps"]
    assert report["semgrep"]["unscanned_sources"] >= 1


def test_local_referenced_script_is_scanned_once(tmp_path):
    (tmp_path / "app.js").write_text("const value = 1;", encoding="utf-8")
    (tmp_path / "page.html").write_text('<script src="app.js?v=1"></script>', encoding="utf-8")
    report = scan(tmp_path)
    assert report["decision"] == "ALLOW"
    assert report["semgrep"]["scanned_files"] == report["semgrep"]["scanned_units"] == 1
    assert report["semgrep"]["coverage_gaps"] == []


def test_entity_decoding_and_template_masking_do_not_drop_literal_code(tmp_path):
    path = tmp_path / "page.html"
    path.write_text('<button onclick="eval(&quot;input&quot;)">go</button>\n'
                    '<script>eval([[${value}]]);</script>', encoding="utf-8")
    coverage = {}
    _, units = source_targets.sources(tmp_path, 1048576, coverage)
    assert 'eval("input")' in units[0].text
    assert 'eval(__SECURITY_GATE_TEMPLATE_VALUE__)' in units[1].text
    assert coverage["coverage_gaps"] == ["TEMPLATE_EXPRESSION"]


def test_template_unit_limit_is_not_a_silent_skip(tmp_path, monkeypatch):
    (tmp_path / "page.html").write_text("<script>const x=1;</script>" * 3, encoding="utf-8")
    monkeypatch.setattr(source_units, "MAX_UNITS", 2)
    assert scan(tmp_path)["semgrep"]["errors"] == ["SOURCE_UNIT_LIMIT_EXCEEDED"]


def test_reported_gaps_match_the_schema_allow_rule():
    schema = json.loads((ROOT / "security_gate" / "gate.schema.json").read_text(encoding="utf-8"))
    allow = next(rule["then"] for rule in schema["$defs"]["semgrep"]["allOf"]
                 if rule["if"]["properties"].get("decision") == {"const": "ALLOW"})
    assert set(allow["properties"]["coverage_gaps"]["items"]["enum"]) == source_targets.REPORTED_GAPS


def test_schema_rejects_allow_with_blocking_gaps_or_nothing_scanned(tmp_path):
    (tmp_path / "app.ts").write_text("const value: number = 1;", encoding="utf-8")
    report = scan(tmp_path)
    for field, value in [("coverage_gaps", ["MALFORMED_TEMPLATE"]), ("coverage_gaps", ["UNSUPPORTED_SCRIPT_TYPE"]),
                         ("scanned_units", 0), ("scanned_languages", [])]:
        changed = copy.deepcopy(report)
        changed["semgrep"][field] = value
        with pytest.raises(jsonschema.ValidationError):
            validate(changed)


def test_board_discovery_includes_every_local_java_and_script_unit():
    board = ROOT.parents[1] / "samples" / "kty-board"
    if not board.is_dir():
        pytest.skip("Optional team sample is absent")
    coverage = {}
    _, units = source_targets.sources(board, 1048576, coverage)
    assert {u.path for u in units if u.language == "java"} == set(board.rglob("*.java"))
    scripts = [u for u in units if u.language == "javascript"]
    assert len(scripts) == 6
    assert len({u.path for u in scripts}) == 3
    assert sorted(u.fixed_line for u in scripts if u.fixed_line) == [62, 65, 82]
    assert coverage["unsupported_files"] == 0
    assert coverage["unscanned_sources"] == 6
    assert coverage["coverage_gaps"] == ["EXTERNAL_SCRIPT_REFERENCE", "TEMPLATE_EXPRESSION"]


REAL = [pytest.mark.semgrep_real,
        pytest.mark.skipif(semgrep.find_executable() is None, reason="Requires actual installed Semgrep CLI")]


@pytest.mark.parametrize("fixture,language,decision", [
    ("javascript_safe", "javascript", "ALLOW"), ("javascript_vulnerable", "javascript", "DENY"),
    ("typescript_safe", "typescript", "ALLOW"), ("typescript_vulnerable", "typescript", "DENY")])
@REAL[0]
@REAL[1]
def test_real_web_language_fixtures(fixture, language, decision):
    report = semgrep.scan_semgrep(FIXTURES / fixture)
    assert report["scan_status"] == "SUCCESS", report
    assert report["decision"] == decision, report
    assert report["scanned_languages"] == [language]
    assert report["scanned_files"] == report["scanned_units"] == 1
    if decision == "DENY":
        assert {f["rule_id"] for f in report["findings"]} == {
            "security-gate-web-dynamic-eval", "security-gate-web-function-constructor", "security-gate-web-shell-exec"}
        assert {f["line"] for f in report["findings"]} == {3, 4, 5}


@REAL[0]
@REAL[1]
def test_real_four_language_project(tmp_path):
    for directory, filename in [("safe", "sample.py"), ("java_safe", "BoardService.java"),
                                 ("javascript_safe", "sample.js"), ("typescript_safe", "sample.ts")]:
        shutil.copy(FIXTURES / directory / filename, tmp_path)
    report = semgrep.scan_semgrep(tmp_path)
    assert report["decision"] == "ALLOW", report
    assert report["scanned_units"] == report["scanned_files"] == 4
    assert report["scanned_languages"] == ["java", "javascript", "python", "typescript"]


@REAL[0]
@REAL[1]
def test_real_template_danger_maps_lines_and_preserves_coverage_gaps(tmp_path):
    path = tmp_path / "page.html"
    path.write_text('<h1>Board</h1>\n<script>\neval(input);\n</script>\n'
                    '<button onclick="new Function(input)()">go</button>\n'
                    '<script src="https://example.invalid/app.js"></script>', encoding="utf-8")
    report = semgrep.scan_semgrep(tmp_path)
    assert report["scan_status"] == "SUCCESS", report
    assert report["decision"] == "DENY", report
    assert report["scanned_files"] == 1 and report["scanned_units"] == 2
    assert {f["line"] for f in report["findings"]} == {3, 5}
    assert all(f["file_path"] == str(path) for f in report["findings"])
    assert report["coverage_gaps"] == ["EXTERNAL_SCRIPT_REFERENCE"]


@REAL[0]
@REAL[1]
@pytest.mark.gitleaks_real
@pytest.mark.parametrize("scenario,decision,exit_code", [("normal", "ALLOW", 0),
    ("danger", "DENY", 1), ("unsupported", "DENY", 1), ("secret", "DENY", 1)])
def test_real_web_cli_schema_exit_and_secrets(tmp_path, scenario, decision, exit_code):
    shutil.copy(FIXTURES / ("javascript_vulnerable" if scenario == "danger" else "javascript_safe") / "sample.js", tmp_path)
    if scenario == "unsupported":
        (tmp_path / "app.c").write_text("int value;", encoding="utf-8")
    if scenario == "secret":
        (tmp_path / ".env").write_text("api_token=" + FAKE, encoding="utf-8")
    run = subprocess.run([sys.executable, str(ROOT / "main.py"), str(tmp_path), "--with-gitleaks"],
                         cwd=ROOT, capture_output=True, text=True, timeout=90)
    assert FAKE not in run.stdout + run.stderr
    assert run.stderr == ""
    report = validate(json.loads(run.stdout))
    assert report["decision"] == decision, report
    assert run.returncode == exit_code
    if scenario == "unsupported":
        assert report["reason_code"] == "UNSUPPORTED_SOURCE" and report["semgrep"]["block_reasons"] == ["UNSUPPORTED_LANGUAGE"]
