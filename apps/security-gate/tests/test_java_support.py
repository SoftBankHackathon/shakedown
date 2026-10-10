"""Coverage, optional Compose policy, and narrowly validated build binaries."""
import copy
import io
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import zipfile

import jsonschema
import pytest
import yaml

from security_gate import cli, gate3, gitleaks, secret_targets, semgrep
from security_gate.gate3 import scan_full_repository
from test_gitleaks import FAKE, runner as secret_runner, validate
from test_semgrep import output_runner

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "semgrep"
WRAPPER = Path("gradle/wrapper/gradle-wrapper.jar")


def java_project(path):
    shutil.copy(FIXTURES / "java_safe" / "BoardService.java", path)
    return path


def jar_bytes(*, entries=None):
    """Synthetic format fixture, never executed as a Java program."""
    buffer = io.BytesIO()
    if entries is None:
        entries = {"META-INF/MANIFEST.MF": b"Manifest-Version: 1.0\n",
                   "org/gradle/wrapper/GradleWrapperMain.class": b"\xca\xfe\xba\xbe\x00\x00\x00\x34"}
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def put_wrapper(path, data=None):
    wrapper = path / WRAPPER
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    wrapper.write_bytes(jar_bytes() if data is None else data)
    return wrapper


def mock_scan(path, **kwargs):
    return validate(scan_full_repository(path, semgrep_runner=output_runner(),
                                        gitleaks_runner=secret_runner(), **kwargs))


def test_java_rules_are_local_fixed_and_known():
    rules = yaml.safe_load(semgrep.JAVA_RULE_FILE.read_text(encoding="utf-8"))["rules"]
    assert {r["id"] for r in rules} == {r for r in semgrep.RULES if "java" in r}
    assert all(r["languages"] == ["java"] for r in rules)
    assert all(set(r) <= {"id", "languages", "severity", "message", "pattern-either"} for r in rules)


def test_java_syntax_preflight_blocks_before_semgrep(tmp_path):
    java_project(tmp_path)
    (tmp_path / "Broken.java").write_text("class Broken { void broken( {", encoding="utf-8")
    def unexpected(*args, **kwargs):
        pytest.fail("Invalid Java must be blocked before Semgrep")
    report = semgrep.scan_semgrep(tmp_path, runner=unexpected)
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["SOURCE_SYNTAX_INVALID"]


def test_mixed_snapshot_preserves_both_languages_and_checks_all_files(tmp_path):
    java_project(tmp_path)
    (tmp_path / "sample.py").write_text("pass", encoding="utf-8")
    calls = []
    report = semgrep.scan_semgrep(tmp_path, runner=output_runner(calls=calls))
    assert report["decision"] == "ALLOW"
    assert report["detected_languages"] == ["java", "python"]
    assert report["scanned_files"] == 2
    command = calls[0][0]
    assert {Path(p).suffix for p in command[command.index("--") + 1:]} == {".py", ".java"}
    assert [command[i + 1] for i, arg in enumerate(command) if arg == "--config"] == [
        str(rule) for rule in semgrep.RULE_FILES]
    report = semgrep.scan_semgrep(tmp_path, runner=output_runner(
        edit=lambda p: p["paths"]["scanned"].pop()))
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["SEMGREP_INCOMPLETE_SCAN"]


@pytest.mark.parametrize("filename,language", [
    ("app.vue", "vue"), ("app.svelte", "svelte"), ("App.kt", "kotlin"),
    ("app.c", "c"), ("app.cs", "csharp"), ("app.rb", "ruby"),
    ("app.mystery", "unknown"), ("executable", "unknown")])
@pytest.mark.parametrize("with_java", [False, True])
def test_unsupported_sources_block_allow(tmp_path, filename, language, with_java):
    if with_java:
        java_project(tmp_path)
    source = {"c": "int main(void) { return 0; }", "csharp": "class App {}", "ruby": "puts 1"}.get(language, "unscanned code")
    (tmp_path / filename).write_text(source, encoding="utf-8")
    report = mock_scan(tmp_path)
    assert (report["decision"], report["reason_code"]) == ("DENY", "UNSUPPORTED_SOURCE")
    assert report["semgrep"]["unsupported_languages"] == [language]
    assert report["semgrep"]["unsupported_files"] == 1
    assert report["semgrep"]["scanned_files"] == int(with_java)


def test_unsupported_sources_do_not_hide_secret_denial(tmp_path):
    java_project(tmp_path)
    (tmp_path / "app.c").write_text("int value;", encoding="utf-8")
    report = validate(scan_full_repository(tmp_path, semgrep_runner=output_runner(),
                                          gitleaks_runner=secret_runner(secret=True)))
    assert report["decision"] == "DENY"


@pytest.mark.parametrize("content,units,unscanned", [("<script>alert(1)</script>", 2, 0),
    ('<script src="remote.js"></script>', 1, 1),
    ('<button onclick="run()">go</button>', 2, 0), ('<a href="javascript:run()">go</a>', 2, 0)])
def test_embedded_javascript_is_scanned_or_explicitly_incomplete(tmp_path, content, units, unscanned):
    java_project(tmp_path)
    (tmp_path / "index.html").write_text(content, encoding="utf-8")
    report = mock_scan(tmp_path)
    # 못 본 범위는 막지 않고 unscanned_sources·coverage_gaps로 남긴다.
    assert report["decision"] == "ALLOW"
    assert report["semgrep"]["scanned_units"] == units
    assert report["semgrep"]["unscanned_sources"] == unscanned


def test_static_html_does_not_require_source_rules(tmp_path):
    java_project(tmp_path)
    (tmp_path / "index.html").write_text("<h1>Board</h1>", encoding="utf-8")
    assert mock_scan(tmp_path)["decision"] == "ALLOW"


@pytest.mark.parametrize("filename", [None, "README.md", "compose.yaml"])
def test_no_supported_source_cannot_allow(tmp_path, filename):
    if filename:
        (tmp_path / filename).write_text("services:\n  app:\n    image: sample\n", encoding="utf-8")
    report = mock_scan(tmp_path)
    assert (report["decision"], report["reason_code"]) == ("DENY", "UNSUPPORTED_SOURCE")


@pytest.mark.parametrize("tool", ["semgrep", "gitleaks"])
@pytest.mark.parametrize("failure", ["missing", "timeout", "partial"])
def test_java_required_failures_are_scan_failed(tmp_path, monkeypatch, tool, failure):
    java_project(tmp_path)
    module = semgrep if tool == "semgrep" else gitleaks
    runners = {"semgrep_runner": output_runner(), "gitleaks_runner": secret_runner()}
    if failure == "missing":
        monkeypatch.setattr(module, "find_executable", lambda: None)
        runners[tool + "_runner"] = None
    elif failure == "timeout":
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired("scanner", 1, output=FAKE, stderr=FAKE)
        runners[tool + "_runner"] = timeout
    else:
        runners[tool + "_runner"] = (output_runner(edit=lambda p: p["paths"].update(scanned=[]))
                                      if tool == "semgrep" else secret_runner(stderr=FAKE.encode()))
    report = validate(scan_full_repository(tmp_path, **runners))
    assert report["decision"] == "SCAN_FAILED"
    assert report[tool]["scan_status"] == "FAILED"
    assert FAKE not in json.dumps(report)


def test_valid_wrapper_is_excluded_but_configuration_and_sources_are_submitted(tmp_path):
    java_project(tmp_path)
    put_wrapper(tmp_path)
    filenames = [".env", "app.properties", "app.yaml", "app.json", "app.xml", "build.gradle", "build.gradle.kts"]
    for name in filenames:
        (tmp_path / name).write_text("token=" + FAKE, encoding="utf-8")
    calls = []
    report = gitleaks.scan_gitleaks(tmp_path, runner=secret_runner(secret=True, calls=calls))
    assert report["decision"] == "DENY"
    assert report["excluded_binary_files"] == 1
    assert report["scanned_files"] == len(filenames) + 1
    assert FAKE not in json.dumps(report)


def test_java_wrapper_full_allow(tmp_path):
    java_project(tmp_path)
    put_wrapper(tmp_path)
    report = mock_scan(tmp_path)
    assert report["decision"] == "ALLOW"
    assert report["gitleaks"]["excluded_binary_files"] == 1


def test_wrapper_only_is_not_automatically_allowed(tmp_path):
    put_wrapper(tmp_path)
    report = mock_scan(tmp_path)
    assert (report["decision"], report["reason_code"]) == ("DENY", "UNSUPPORTED_SOURCE")
    assert report["gitleaks"]["scan_status"] == "NOT_APPLICABLE"
    assert report["gitleaks"]["excluded_binary_files"] == 1


@pytest.mark.parametrize("data", [b"\xff\xfe", b"PK\x03\x04broken", b"bad\x00data",
                                       jar_bytes(entries={"other.txt": b"plain"})])
def test_invalid_build_binary_fails_closed(tmp_path, data):
    java_project(tmp_path)
    put_wrapper(tmp_path, data)
    assert mock_scan(tmp_path)["decision"] == "SCAN_FAILED"


def test_jar_extension_does_not_hide_text(tmp_path):
    put_wrapper(tmp_path, ("token=" + FAKE).encode())
    report = gitleaks.scan_gitleaks(tmp_path, runner=secret_runner(secret=True))
    assert report["decision"] == "DENY"
    assert report["scanned_files"] == 1 and report["excluded_binary_files"] == 0


@pytest.mark.parametrize("filename", ["unknown.bin", "other.jar", "app.properties"])
def test_unapproved_binary_path_or_type_fails(tmp_path, filename):
    (tmp_path / filename).write_bytes(jar_bytes())
    assert gitleaks.scan_gitleaks(tmp_path, runner=secret_runner())["decision"] == "SCAN_FAILED"


def test_binary_limits_are_enforced_before_exclusion(tmp_path, monkeypatch):
    put_wrapper(tmp_path)
    assert gitleaks.scan_gitleaks(tmp_path, runner=secret_runner(), max_file_bytes=1)["errors"] == ["FILE_SIZE_LIMIT_EXCEEDED"]
    monkeypatch.setattr(secret_targets, "MAX_TOTAL_BYTES", 1)
    assert gitleaks.scan_gitleaks(tmp_path, runner=secret_runner())["errors"] == ["SECRET_TOTAL_SIZE_LIMIT_EXCEEDED"]


@pytest.mark.parametrize("defect", ["truncated", "class", "manifest", "traversal", "link", "expanded"])
def test_invalid_jar_structure_and_expansion_fail(tmp_path, defect):
    entries = {"META-INF/MANIFEST.MF": b"Manifest-Version: 1.0\n",
               "org/gradle/wrapper/GradleWrapperMain.class": b"\xca\xfe\xba\xbe"}
    if defect == "class":
        entries["org/gradle/wrapper/GradleWrapperMain.class"] = b"not a class"
    elif defect == "manifest":
        entries["META-INF/MANIFEST.MF"] = b"not a manifest"
    elif defect == "traversal":
        entries["../escape"] = b"x"
    elif defect == "link":
        info = zipfile.ZipInfo("link")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        entries[info] = b"target"
    elif defect == "expanded":
        entries["large"] = b"x" * (secret_targets.MAX_TOTAL_BYTES + 1)
    data = jar_bytes(entries=entries)
    put_wrapper(tmp_path, data[:-20] if defect == "truncated" else data)
    assert gitleaks.scan_gitleaks(tmp_path, runner=secret_runner())["errors"] == ["GITLEAKS_INVALID_BUILD_BINARY"]


def test_schema_rejects_forged_allow_for_unsupported_or_required_na(tmp_path):
    java_project(tmp_path)
    report = mock_scan(tmp_path)
    assert report["decision"] == "ALLOW"
    # 검사할 소스가 없으면 Semgrep은 DENY, 비밀 검사 대상이 없으면 전체 ALLOW가 될 수 없다.
    for tool, decision in (("semgrep", "DENY"), ("gitleaks", "ALLOW")):
        changed = copy.deepcopy(report)
        changed[tool].update(scan_status="NOT_APPLICABLE", decision=decision, scanned_files=0)
        with pytest.raises(jsonschema.ValidationError):
            validate(changed)
    changed = copy.deepcopy(report)
    changed["semgrep"].update(unsupported_languages=["kotlin"], unsupported_files=1)
    with pytest.raises(jsonschema.ValidationError):
        validate(changed)


def test_old_example_reports_still_validate():
    for path in (ROOT / "examples").glob("*-v3.json"):
        if path.name != "request-v3.json":
            validate(json.loads(path.read_text(encoding="utf-8")))


@pytest.mark.gitleaks_real
@pytest.mark.skipif(gitleaks.find_executable() is None, reason="Requires real local Gitleaks")
@pytest.mark.parametrize("filename", [".env", "application.properties", "application.yaml", "app.json",
                                     "app.xml", "build.gradle", "build.gradle.kts", "Secret.java"])
def test_real_wrapper_does_not_hide_text_secrets(tmp_path, filename, capsys):
    put_wrapper(tmp_path)
    (tmp_path / filename).write_text("token=" + FAKE, encoding="utf-8")
    report = gitleaks.scan_gitleaks(tmp_path)
    assert report["decision"] == "DENY", report
    assert report["excluded_binary_files"] == 1
    assert report["scanned_files"] == 1
    assert FAKE not in json.dumps(report)
    output = capsys.readouterr()
    assert FAKE not in output.out + output.err


@pytest.mark.semgrep_real
@pytest.mark.gitleaks_real
@pytest.mark.skipif(semgrep.find_executable() is None or gitleaks.find_executable() is None,
                    reason="Requires real local Semgrep and Gitleaks CLIs")
@pytest.mark.parametrize("scenario,decision,exit_code", [
    ("safe", "ALLOW", 0), ("danger", "DENY", 1), ("wrapper", "ALLOW", 0),
    ("secret", "DENY", 1), ("unsupported", "DENY", 1), ("invalid", "SCAN_FAILED", 3)])
def test_real_java_cli_scenarios(tmp_path, scenario, decision, exit_code):
    java_project(tmp_path)
    if scenario == "danger":
        shutil.copy(FIXTURES / "java_vulnerable" / "CommandService.java", tmp_path)
    elif scenario == "wrapper":
        put_wrapper(tmp_path)
    elif scenario == "secret":
        (tmp_path / "application.properties").write_text("api_token=" + FAKE, encoding="utf-8")
    elif scenario == "unsupported":
        (tmp_path / "app.kt").write_text("fun main() {}", encoding="utf-8")
    elif scenario == "invalid":
        (tmp_path / "Broken.java").write_text("class Broken { void broken( {", encoding="utf-8")
    completed = subprocess.run([sys.executable, str(ROOT / "main.py"), str(tmp_path), "--with-gitleaks"],
                               cwd=ROOT, capture_output=True, text=True, timeout=90)
    assert FAKE not in completed.stdout + completed.stderr
    assert completed.stderr == ""
    report = validate(json.loads(completed.stdout))
    assert completed.returncode == exit_code, report
    assert report["decision"] == decision, report
    if scenario == "unsupported":
        assert report["reason_code"] == "UNSUPPORTED_SOURCE" and report["semgrep"]["unsupported_languages"] == ["kotlin"]
    assert report["docker_compose"]["scan_status"] == "NOT_APPLICABLE"
    if scenario == "wrapper":
        assert report["gitleaks"]["excluded_binary_files"] == 1
    if scenario == "invalid":
        healthy = semgrep.scan_semgrep(FIXTURES / "java_safe")
        assert healthy["decision"] == "ALLOW", healthy
