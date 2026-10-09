"""Final MVP scenario matrix using existing adapters, schemas and local rules."""
from collections import Counter
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from security_gate import cli, gate3, gitleaks, semgrep
from security_gate.gate3 import scan_full_repository
from test_gitleaks import FAKE, RULE, runner as secret_runner, validate
from test_semgrep import output_runner

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
COMBINED = FIXTURES / "integration" / "combined"
SCENARIOS = [
    (FIXTURES / "gitleaks" / "safe", "ALLOW", "ALLOW", "ALLOW", "ALLOW"),
    (FIXTURES / "integration" / "docker_risk", "DENY", "ALLOW", "ALLOW", "DENY"),
    (FIXTURES / "semgrep" / "vulnerable", "ALLOW", "DENY", "ALLOW", "DENY"),
    (FIXTURES / "gitleaks" / "secret", "ALLOW", "ALLOW", "DENY", "DENY"),
    (COMBINED, "DENY", "DENY", "DENY", "DENY"),
]


def verify_findings(report):
    expected = []
    for file in report["docker_compose"]["files"]:
        for item in file["findings"]:
            expected.append(("docker_compose", item["rule_id"], item["file_path"], item["location"]["line"]))
    for tool in ("semgrep", "gitleaks"):
        expected.extend((f["tool"], f["rule_id"], f["file_path"], f["line"]) for f in report[tool]["findings"])
    actual = [(f["tool"], f["rule_id"], f["file_path"], f["line"]) for f in report["findings"]]
    assert Counter(actual) == Counter(expected)
    # Controlled fixtures contain one location per rule; different rules on the
    # same source are retained as separate policy findings.
    assert len(actual) == len(set(actual))
    assert FAKE not in json.dumps(report)
    validate(report)


@pytest.mark.parametrize("path,docker,code,secrets,final", SCENARIOS,
                         ids=["normal", "docker-risk", "semgrep-risk", "secret-risk", "combined-risk"])
def test_mock_final_scenario_matrix(path, docker, code, secrets, final):
    report = scan_full_repository(path, semgrep_runner=output_runner(findings=code == "DENY"),
                                  gitleaks_runner=secret_runner(secret=secrets == "DENY"))
    assert report["docker_compose"]["decision"] == docker
    assert report["semgrep"]["decision"] == code
    assert report["gitleaks"]["decision"] == secrets
    assert report["decision"] == final
    verify_findings(report)


def broken_runner(tool, failure):
    def run(command, **kwargs):
        if tool == "gitleaks" and command[1] == "version":
            return secret_runner()(command, **kwargs)
        if failure == "timeout":
            raise subprocess.TimeoutExpired("scanner", 1, output=FAKE, stderr=FAKE)
        if failure == "access":
            raise PermissionError(FAKE)
        if failure == "exception":
            raise RuntimeError(FAKE)
        if tool == "semgrep":
            return subprocess.CompletedProcess(command, 2 if failure == "execution" else 0,
                                               FAKE.encode(), FAKE.encode())
        return secret_runner(code=1 if failure == "execution" else 0,
                             raw=FAKE.encode())(command, **kwargs)
    return run


@pytest.mark.parametrize("tool", ["semgrep", "gitleaks"])
@pytest.mark.parametrize("failure", ["execution", "timeout", "json", "access", "exception"])
def test_required_scan_failure_keeps_other_tool_risks(tool, failure, capsys):
    sg_runner = broken_runner(tool, failure) if tool == "semgrep" else output_runner(findings=True)
    gl_runner = broken_runner(tool, failure) if tool == "gitleaks" else secret_runner(secret=True)
    report = scan_full_repository(COMBINED, semgrep_runner=sg_runner, gitleaks_runner=gl_runner)
    assert report["decision"] == "SCAN_FAILED"
    assert report["scan_status"] == "FAILED"
    assert report["reason_code"] == "REQUIRED_SCAN_FAILED"
    assert report[tool]["decision"] == "SCAN_FAILED" and report[tool]["errors"]
    other = "gitleaks" if tool == "semgrep" else "semgrep"
    assert report[other]["decision"] == report["docker_compose"]["decision"] == "DENY"
    assert {f["tool"] for f in report["findings"]} == {"docker_compose", other}
    verify_findings(report)
    output = capsys.readouterr()
    assert FAKE not in output.out + output.err


@pytest.mark.parametrize("tool", ["semgrep", "gitleaks"])
def test_missing_required_scanner_preserves_other_denials(monkeypatch, tool):
    monkeypatch.setattr(semgrep if tool == "semgrep" else gitleaks, "find_executable", lambda: None)
    report = scan_full_repository(COMBINED,
                                  semgrep_runner=None if tool == "semgrep" else output_runner(findings=True),
                                  gitleaks_runner=None if tool == "gitleaks" else secret_runner(secret=True))
    assert report[tool]["errors"] == [tool.upper() + "_NOT_INSTALLED"]
    assert report["decision"] == "SCAN_FAILED"
    other = "gitleaks" if tool == "semgrep" else "semgrep"
    assert {f["tool"] for f in report["findings"]} == {"docker_compose", other}
    verify_findings(report)


def test_incomplete_semgrep_scan_preserves_valid_findings_from_all_tools():
    report = scan_full_repository(COMBINED,
        semgrep_runner=output_runner(findings=True, edit=lambda p: p["paths"].update(scanned=[])),
        gitleaks_runner=secret_runner(secret=True))
    assert report["decision"] == "SCAN_FAILED"
    assert report["semgrep"]["errors"] == ["SEMGREP_INCOMPLETE_SCAN"]
    assert {f["tool"] for f in report["findings"]} == {"docker_compose", "semgrep", "gitleaks"}
    verify_findings(report)


def test_syntax_failure_preserves_docker_and_secret_findings(tmp_path):
    shutil.copytree(COMBINED, tmp_path / "repo")
    path = tmp_path / "repo"
    (path / "sample.py").write_text("def incomplete(", encoding="utf-8")
    report = scan_full_repository(path,
        semgrep_runner=lambda *a, **kw: pytest.fail("Syntax-invalid source must not reach Semgrep"),
        gitleaks_runner=secret_runner(secret=True))
    assert report["decision"] == "SCAN_FAILED"
    assert report["semgrep"]["errors"] == ["SOURCE_SYNTAX_INVALID"]
    assert {f["tool"] for f in report["findings"]} == {"docker_compose", "gitleaks"}
    verify_findings(report)


def test_missing_target_and_read_errors_never_allow(tmp_path, monkeypatch):
    report = scan_full_repository(tmp_path / "missing", semgrep_runner=output_runner(),
                                  gitleaks_runner=secret_runner())
    assert report["decision"] == "SCAN_FAILED"
    assert all(report[tool]["decision"] == "SCAN_FAILED" for tool in ("docker_compose", "semgrep", "gitleaks"))
    validate(report)
    def unreadable(*args):
        raise PermissionError(FAKE)
    monkeypatch.setattr(semgrep, "sources", unreadable)
    report = scan_full_repository(COMBINED, semgrep_runner=output_runner(), gitleaks_runner=secret_runner(secret=True))
    assert report["semgrep"]["errors"] == ["SEMGREP_IO_FAILED"]
    assert report["decision"] == "SCAN_FAILED"
    verify_findings(report)


def test_secret_error_logs_preserve_findings_without_echoing_values():
    report = scan_full_repository(COMBINED, semgrep_runner=output_runner(findings=True),
                                  gitleaks_runner=secret_runner(secret=True, stderr=FAKE.encode()))
    assert report["gitleaks"]["errors"] == ["GITLEAKS_SCAN_ERRORS"]
    assert report["decision"] == "SCAN_FAILED"
    assert {f["tool"] for f in report["findings"]} == {"docker_compose", "semgrep", "gitleaks"}
    verify_findings(report)


def test_cleanup_failure_keeps_already_normalized_secret_evidence(monkeypatch, record_property):
    actual_directory = gitleaks.tempfile.TemporaryDirectory
    class FailedCleanup:
        def __init__(self, *args, **kwargs):
            self.fail = kwargs.get("prefix", "").startswith("gitleaks-")
            self.directory = actual_directory(*args, **kwargs)
        def __enter__(self):
            return self.directory.__enter__()
        def __exit__(self, *args):
            self.directory.__exit__(*args)
            if self.fail:
                raise PermissionError(FAKE)
    monkeypatch.setattr(gitleaks.tempfile, "TemporaryDirectory", FailedCleanup)
    report = scan_full_repository(COMBINED, semgrep_runner=output_runner(findings=True),
                                  gitleaks_runner=secret_runner(secret=True))
    assert report["decision"] == "SCAN_FAILED"
    assert report["gitleaks"]["errors"] == ["GITLEAKS_CLEANUP_FAILED"]
    assert {f["rule_id"] for f in report["gitleaks"]["findings"]} == {RULE}
    assert report["gitleaks"]["version"] == "8.30.0"
    assert report["gitleaks"]["scanned_files"] == 3
    verify_findings(report)
    record_property("security_gate_report", json.dumps(report))


def test_final_cli_error_json_does_not_contain_tool_exception_or_secret(monkeypatch, capsys):
    original = gate3.scan_full_repository
    def full(path, **kwargs):
        return original(path, semgrep_runner=broken_runner("semgrep", "exception"),
                        gitleaks_runner=secret_runner(secret=True), **kwargs)
    monkeypatch.setattr(gate3, "scan_full_repository", full)
    assert cli.main([str(COMBINED), "--with-gitleaks"]) == 3
    output = capsys.readouterr()
    assert output.err == ""
    assert FAKE not in output.out
    report = json.loads(output.out)
    assert report["semgrep"]["errors"] == ["SEMGREP_INTERNAL_ERROR"]
    verify_findings(report)


@pytest.mark.semgrep_real
@pytest.mark.gitleaks_real
@pytest.mark.skipif(semgrep.find_executable() is None or gitleaks.find_executable() is None,
                    reason="Final real integration requires both local scanner CLIs")
@pytest.mark.parametrize("path,docker,code,secrets,final", SCENARIOS,
                         ids=["normal", "docker-risk", "semgrep-risk", "secret-risk", "combined-risk"])
def test_real_final_scenario_matrix(path, docker, code, secrets, final, capsys, record_property):
    report = scan_full_repository(path)
    assert report["docker_compose"]["decision"] == docker, report
    assert report["semgrep"]["decision"] == code, report
    assert report["gitleaks"]["decision"] == secrets, report
    assert report["decision"] == final, report
    if code == "DENY":
        assert len(report["semgrep"]["findings"]) == 2
    if secrets == "DENY":
        assert RULE in {f["rule_id"] for f in report["gitleaks"]["findings"]}
    verify_findings(report)
    output = capsys.readouterr()
    assert FAKE not in output.out + output.err
    record_property("security_gate_report", json.dumps(report))


def test_json_1_2_3_cli_contracts_and_nested_reports_remain_compatible(monkeypatch, capsys):
    from security_gate import gate
    from test_semgrep import SCHEMA as V2_SCHEMA, REGISTRY as V2_REGISTRY
    from test_security_gate import SCHEMA as V1_SCHEMA
    import jsonschema
    previous = gate.scan_repository
    full_previous = gate3.scan_full_repository
    monkeypatch.setattr(gate, "scan_repository", lambda path, **kw: previous(path, semgrep_runner=output_runner(), **kw))
    monkeypatch.setattr(gate3, "scan_full_repository", lambda path, **kw: full_previous(
        path, semgrep_runner=output_runner(), gitleaks_runner=secret_runner(), **kw))
    reports = []
    path = FIXTURES / "gitleaks" / "safe"
    for options in ([], ["--with-semgrep"], ["--with-gitleaks"]):
        assert cli.main([str(path), *options]) == 0
        captured = capsys.readouterr()
        assert captured.err == ""
        reports.append(json.loads(captured.out))
    first, second, third = reports
    jsonschema.Draft202012Validator(V1_SCHEMA).validate(first)
    jsonschema.Draft202012Validator(V2_SCHEMA, registry=V2_REGISTRY).validate(second)
    validate(third)
    assert [r["schema_version"] for r in reports] == ["1.0", "2.0", "3.0"]
    assert first == second["docker_compose"] == third["docker_compose"]
    assert second["semgrep"] == third["semgrep"]


@pytest.mark.semgrep_real
@pytest.mark.gitleaks_real
@pytest.mark.skipif(semgrep.find_executable() is None or gitleaks.find_executable() is None,
                    reason="Final real CLI requires both local scanner CLIs")
@pytest.mark.parametrize("path,exit_code,decision", [
    (FIXTURES / "gitleaks" / "safe", 0, "ALLOW"), (COMBINED, 1, "DENY"),
])
def test_real_final_cli_json_exit_codes_and_secret_protection(path, exit_code, decision):
    completed = subprocess.run([sys.executable, str(ROOT / "main.py"), str(path), "--with-gitleaks"],
                               cwd=ROOT, capture_output=True, text=True, timeout=90)
    assert completed.returncode == exit_code, completed.stderr
    assert completed.stderr == ""
    assert FAKE not in completed.stdout + completed.stderr
    report = json.loads(completed.stdout)
    assert report["decision"] == decision
    verify_findings(report)
