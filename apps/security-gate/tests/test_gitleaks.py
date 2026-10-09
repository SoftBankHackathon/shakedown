"""Mock CLI outputs test the adapter; they do not prove engine detection."""
import io
import json
from pathlib import Path
import subprocess
import tomllib
from types import SimpleNamespace

import jsonschema
import pytest
from referencing import Registry, Resource

from security_gate import gitleaks, secret_targets
from security_gate.gate3 import scan_full_repository
from security_gate.models import ScanError

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "gitleaks"
FAKE = "SGLAB_FAKE_TOKEN_0123456789abcdefghijklmnop"
RULE = "security-gate-lab-api-token"
SCHEMA = json.loads((ROOT / "security_gate" / "gate3.schema.json").read_text(encoding="utf-8"))
REGISTRY = Registry().with_resources([
    ("urn:security-gate:docker-report:v1", Resource.from_contents(json.loads((ROOT / "security_gate" / "report.schema.json").read_text(encoding="utf-8")))),
    ("urn:security-gate:integrated-report:v2", Resource.from_contents(json.loads((ROOT / "security_gate" / "gate.schema.json").read_text(encoding="utf-8")))),
])


def validate(report):
    jsonschema.Draft202012Validator(SCHEMA, registry=REGISTRY).validate(report)
    return report


def runner(*, secret=False, code=None, version=b"8.30.0\n", version_code=0,
           raw=None, edit=None, missing=False, stderr=b"", calls=None):
    def run(command, **kwargs):
        if calls is not None:
            calls.append((command, kwargs))
        if command[1] == "version":
            return subprocess.CompletedProcess(command, version_code, version, b"")
        inputs = Path(command[2])
        report = Path(command[command.index("--report-path") + 1])
        payload = []
        if secret:
            file = sorted(inputs.iterdir())[-1]
            payload.append({"RuleID": RULE, "File": str(file), "StartLine": 2,
                            "Secret": FAKE, "Match": FAKE, "Description": FAKE,
                            "Fingerprint": FAKE, "Author": FAKE, "Email": FAKE})
        if edit:
            edit(payload)
        if not missing:
            report.write_bytes(raw if raw is not None else json.dumps(payload).encode())
        return subprocess.CompletedProcess(command, (10 if secret else 0) if code is None else code,
                                           FAKE.encode(), stderr)
    return run


def semgrep_runner(*, error=False):
    def run(command, **kwargs):
        names = command[command.index("--") + 1:]
        return subprocess.CompletedProcess(command, 0, json.dumps({
            "results": [], "errors": [{"message": FAKE}] if error else [],
            "paths": {"scanned": names}}).encode(), b"")
    return run


def test_mock_clean_success_checks_version_and_uses_dir_mode():
    calls = []
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(calls=calls))
    assert report["decision"] == "ALLOW"
    assert report["version"] == "8.30.0"
    assert report["scanned_files"] == 3
    assert [c[0][1] for c in calls] == ["version", "dir"]


def test_mock_secret_is_denied_but_raw_fields_and_logs_are_never_forwarded(capsys):
    report = gitleaks.scan_gitleaks(FIXTURES / "secret", runner=runner(secret=True))
    assert report["decision"] == "DENY"
    finding = report["findings"][0]
    assert finding == {"tool": "gitleaks", "rule_id": RULE,
                       "file_path": str(FIXTURES / "secret" / "settings.env"), "line": 2,
                       "severity": "HIGH", "reason_code": "SECRET_EXPOSURE", "decision": "DENY"}
    assert FAKE not in json.dumps(report)
    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == ""


def test_missing_gitleaks_is_not_allow(monkeypatch):
    monkeypatch.setattr(gitleaks, "find_executable", lambda: None)
    report = gitleaks.scan_gitleaks(FIXTURES / "safe")
    assert report["errors"] == ["GITLEAKS_NOT_INSTALLED"]
    assert report["decision"] == "SCAN_FAILED"


@pytest.mark.parametrize("code", [1, 2, -9])
def test_mock_execution_failure(code):
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(code=code))
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["GITLEAKS_EXECUTION_FAILED"]


@pytest.mark.parametrize("failure,error", [(subprocess.TimeoutExpired("private", 1), "GITLEAKS_TIMEOUT"),
                                         (OSError(FAKE), "GITLEAKS_IO_FAILED"),
                                         (RuntimeError(FAKE), "GITLEAKS_INTERNAL_ERROR")])
def test_mock_cli_failure_and_temporary_cleanup(failure, error):
    calls = []
    def run(command, **kwargs):
        calls.append(kwargs["cwd"])
        raise failure
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=run)
    assert report["errors"] == [error]
    assert all(not path.exists() for path in calls)
    assert FAKE not in json.dumps(report)


@pytest.mark.parametrize("raw,error", [(b"PRIVATE_NOT_JSON", "GITLEAKS_INVALID_JSON"),
                                      (b"\xff", "GITLEAKS_INVALID_JSON"),
                                      (b"{}", "GITLEAKS_INVALID_RESULT"),
                                      (b"null", "GITLEAKS_INVALID_RESULT")])
def test_mock_invalid_report(raw, error):
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(raw=raw))
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == [error]


def test_missing_report_is_failure():
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(missing=True))
    assert report["errors"] == ["GITLEAKS_REPORT_MISSING"]


@pytest.mark.parametrize("version,error", [(b"private-secret", "GITLEAKS_VERSION_INVALID"),
                                          (b"8.19.0", "GITLEAKS_UNSUPPORTED_VERSION"),
                                          (b"9.0.0", "GITLEAKS_UNSUPPORTED_VERSION")])
def test_version_is_validated_before_scanning(version, error):
    calls = []
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(version=version, calls=calls))
    assert report["errors"] == [error]
    assert len(calls) == 1


def test_version_command_failure_is_not_scan_success():
    assert gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(version_code=1))["errors"] == ["GITLEAKS_VERSION_FAILED"]


@pytest.mark.parametrize("secret,code", [(False, 10), (True, 0)])
def test_inconsistent_exit_and_report_fail_closed(secret, code):
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(secret=secret, code=code))
    assert report["errors"] == ["GITLEAKS_INCONSISTENT_RESULT"]
    assert report["decision"] == "SCAN_FAILED"


def test_logged_scan_error_does_not_allow_or_echo_secret():
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(stderr=FAKE.encode()))
    assert report["errors"] == ["GITLEAKS_SCAN_ERRORS"]
    assert FAKE not in json.dumps(report)


@pytest.mark.parametrize("edit,error", [
    (lambda p: p[0].update(File="../../forbidden-project/file.env"), "GITLEAKS_UNEXPECTED_RESULT_PATH"),
    (lambda p: p[0].update(StartLine=True), "GITLEAKS_INVALID_RESULT"),
    (lambda p: p[0].update(RuleID=FAKE), "GITLEAKS_INVALID_RULE_ID"),
    (lambda p: p[0].update(RuleID="sentinel-secret", Secret="sentinel-secret"), "GITLEAKS_SENSITIVE_METADATA"),
])
def test_invalid_finding_metadata_is_not_echoed(edit, error):
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(secret=True, edit=edit))
    assert report["errors"] == [error]
    assert FAKE not in json.dumps(report)


def test_command_is_redacted_and_cannot_use_target_configuration(monkeypatch):
    monkeypatch.setenv("GITLEAKS_CONFIG", "forbidden-path")
    monkeypatch.setenv("GITLEAKS_CONFIG_TOML", FAKE)
    calls = []
    gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(calls=calls))
    command, kwargs = calls[-1]
    assert "--redact=100" in command and "--ignore-gitleaks-allow" in command
    assert command[command.index("--config") + 1] == str(gitleaks.CONFIG_FILE)
    assert command[command.index("--exit-code") + 1] == "10"
    assert command[command.index("--log-level") + 1] == "error"
    assert not {"GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML", "PATH"} & set(kwargs["env"])
    assert Path(command[2]) != Path(command[command.index("--report-path") + 1]).parent
    assert not kwargs["cwd"].exists()


@pytest.mark.parametrize("secret,raw", [(False, None), (True, None), (False, b"bad")])
def test_snapshot_and_raw_report_are_removed_on_success_deny_and_parse_error(secret, raw):
    calls = []
    gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(secret=secret, raw=raw, calls=calls))
    assert all(not kwargs["cwd"].exists() for _, kwargs in calls)


def test_cleanup_failure_prevents_allow(monkeypatch):
    original = gitleaks.tempfile.TemporaryDirectory
    class BrokenCleanup:
        def __init__(self, *args, **kwargs):
            self.actual = original(*args, **kwargs)
        def __enter__(self):
            return self.actual.__enter__()
        def __exit__(self, *args):
            self.actual.__exit__(*args)
            raise PermissionError(FAKE)
    monkeypatch.setattr(gitleaks.tempfile, "TemporaryDirectory", BrokenCleanup)
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner())
    assert report["errors"] == ["GITLEAKS_CLEANUP_FAILED"]
    assert FAKE not in json.dumps(report)


def test_no_text_files_requires_review(tmp_path):
    report = gitleaks.scan_gitleaks(tmp_path, runner=runner())
    assert report["scan_status"] == "NOT_APPLICABLE"
    assert report["decision"] == "REVIEW"


def test_targets_are_never_executed_and_ignore_files_do_not_hide_them(tmp_path):
    (tmp_path / "untrusted.py").write_text("raise RuntimeError('must not run')", encoding="utf-8")
    (tmp_path / ".gitleaks.toml").write_text("untrusted configuration", encoding="utf-8")
    (tmp_path / ".gitleaksignore").write_text("*", encoding="utf-8")
    report = gitleaks.scan_gitleaks(tmp_path, runner=runner())
    assert report["decision"] == "ALLOW" and report["scanned_files"] == 3


@pytest.mark.parametrize("source,limit,error", [("pass\n" * 100, 8, "FILE_SIZE_LIMIT_EXCEEDED"),
                                             ("\x00", 1024, "GITLEAKS_UNSUPPORTED_TEXT")])
def test_unsupported_or_oversized_targets_fail_closed(tmp_path, source, limit, error):
    (tmp_path / "sample.txt").write_text(source, encoding="utf-8")
    report = gitleaks.scan_gitleaks(tmp_path, max_file_bytes=limit, runner=runner())
    assert report["errors"] == [error]


def test_link_branch_rejects_before_copy(monkeypatch):
    monkeypatch.setattr(secret_targets, "is_link", lambda metadata: True)
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner())
    assert report["errors"] == ["SYMLINK_OR_REPARSE_POINT"]


@pytest.mark.parametrize("limits", [{"timeout_seconds": 0}, {"timeout_seconds": float("nan")}, {"max_file_bytes": True}])
def test_invalid_scan_limits_fail_closed(limits):
    assert gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(), **limits)["errors"] == ["INVALID_SCAN_LIMITS"]


@pytest.mark.parametrize("secret,error,decision", [(False, False, "ALLOW"), (True, False, "DENY"),
                                                (False, True, "SCAN_FAILED"), (True, True, "SCAN_FAILED")])
def test_all_three_scans_are_combined_and_schema_valid(secret, error, decision):
    report = validate(scan_full_repository(FIXTURES / "safe", semgrep_runner=semgrep_runner(error=error),
                                          gitleaks_runner=runner(secret=secret)))
    assert report["decision"] == decision
    assert report["docker_compose"]["schema_version"] == "1.0"
    assert FAKE not in json.dumps(report)


def test_gitleaks_failure_blocks_two_successful_checks():
    report = validate(scan_full_repository(FIXTURES / "safe", semgrep_runner=semgrep_runner(),
                                          gitleaks_runner=runner(code=1)))
    assert report["docker_compose"]["decision"] == report["semgrep"]["decision"] == "ALLOW"
    assert report["decision"] == "SCAN_FAILED"


def test_docker_risk_and_secret_findings_are_kept_together(tmp_path):
    (tmp_path / "compose.yaml").write_text("services:\n  app:\n    privileged: true\n", encoding="utf-8")
    (tmp_path / "sample.py").write_text("pass", encoding="utf-8")
    report = validate(scan_full_repository(tmp_path, semgrep_runner=semgrep_runner(), gitleaks_runner=runner(secret=True)))
    assert report["decision"] == "DENY"
    assert {f["tool"] for f in report["findings"]} == {"docker_compose", "gitleaks"}


def test_missing_compose_keeps_review(tmp_path):
    (tmp_path / "sample.py").write_text("pass", encoding="utf-8")
    report = validate(scan_full_repository(tmp_path, semgrep_runner=semgrep_runner(), gitleaks_runner=runner()))
    assert report["decision"] == "REVIEW"


def test_v3_cli_activates_all_checks_with_mock_adapters(monkeypatch, capsys):
    from security_gate import cli, gate3
    original = gate3.scan_full_repository
    def full(target, **kwargs):
        return original(target, semgrep_runner=semgrep_runner(), gitleaks_runner=runner(), **kwargs)
    monkeypatch.setattr(gate3, "scan_full_repository", full)
    assert cli.main([str(FIXTURES / "safe"), "--with-gitleaks"]) == 0
    validate(json.loads(capsys.readouterr().out))


def test_process_runner_discards_secret_logs_and_uses_no_shell(tmp_path, monkeypatch):
    def popen(command, **kwargs):
        assert kwargs["shell"] is False
        return SimpleNamespace(stdout=io.BytesIO(FAKE.encode()), stderr=io.BytesIO(FAKE.encode()),
                               returncode=10, wait=lambda **kw: 10, poll=lambda: 10)
    monkeypatch.setattr(gitleaks.subprocess, "Popen", popen)
    completed = gitleaks.run_cli(["mock", "dir"], cwd=tmp_path, env={}, timeout=1)
    assert completed.stdout == b""
    assert completed.stderr == b"OUTPUT_PRESENT"


def test_process_runner_timeout_kills_process(tmp_path, monkeypatch):
    killed = []
    process = SimpleNamespace(stdout=io.BytesIO(), stderr=io.BytesIO(), returncode=None,
                              poll=lambda: None, kill=lambda: killed.append(True), wait=lambda **kw: 0)
    monkeypatch.setattr(gitleaks.subprocess, "Popen", lambda *a, **kw: process)
    with pytest.raises(subprocess.TimeoutExpired):
        gitleaks.run_cli(["mock", "dir"], cwd=tmp_path, env={}, timeout=-1)
    assert killed == [True]


def test_scan_timeout_removes_a_partial_secret_report():
    calls = []
    normal = runner()
    def run(command, **kwargs):
        calls.append(kwargs["cwd"])
        if command[1] == "version":
            return normal(command, **kwargs)
        report = Path(command[command.index("--report-path") + 1])
        report.write_text(FAKE, encoding="utf-8")
        raise subprocess.TimeoutExpired("gitleaks", 1)
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=run)
    assert report["errors"] == ["GITLEAKS_TIMEOUT"]
    assert all(not path.exists() for path in calls)
    assert FAKE not in json.dumps(report)


def test_oversized_report_is_failure_and_removed(monkeypatch):
    calls = []
    monkeypatch.setattr(gitleaks, "MAX_REPORT_BYTES", 8)
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(raw=b"x" * 16, calls=calls))
    assert report["errors"] == ["GITLEAKS_REPORT_LIMIT_EXCEEDED"]
    assert all(not kwargs["cwd"].exists() for _, kwargs in calls)


def test_excess_findings_are_not_returned(monkeypatch):
    monkeypatch.setattr(gitleaks, "MAX_FINDINGS", 0)
    report = gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner(secret=True))
    assert report["errors"] == ["GITLEAKS_FINDING_LIMIT_EXCEEDED"]


def test_process_output_limit_does_not_echo_secret(tmp_path, monkeypatch):
    monkeypatch.setattr(gitleaks, "MAX_LOG_BYTES", 4)
    process = SimpleNamespace(stdout=io.BytesIO(FAKE.encode()), stderr=io.BytesIO(),
                              returncode=0, poll=lambda: 0, wait=lambda **kw: 0)
    monkeypatch.setattr(gitleaks.subprocess, "Popen", lambda *a, **kw: process)
    with pytest.raises(ScanError, match="GITLEAKS_OUTPUT_LIMIT_EXCEEDED"):
        gitleaks.run_cli(["mock", "dir"], cwd=tmp_path, env={}, timeout=1)


def test_directory_mode_rejects_a_direct_file_and_wrong_path(tmp_path):
    assert gitleaks.scan_gitleaks(FIXTURES / "safe" / "sample.py", runner=runner())["errors"] == ["GITLEAKS_DIRECTORY_REQUIRED"]
    assert gitleaks.scan_gitleaks(tmp_path / "missing", runner=runner())["decision"] == "SCAN_FAILED"


def test_secret_discovery_and_total_size_limits(monkeypatch):
    monkeypatch.setattr(secret_targets, "MAX_FILES", 0)
    assert gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner())["errors"] == ["SECRET_DISCOVERY_LIMIT_EXCEEDED"]
    monkeypatch.setattr(secret_targets, "MAX_FILES", 256)
    monkeypatch.setattr(secret_targets, "MAX_TOTAL_BYTES", 1)
    assert gitleaks.scan_gitleaks(FIXTURES / "safe", runner=runner())["errors"] == ["SECRET_TOTAL_SIZE_LIMIT_EXCEEDED"]


def test_schema_rejects_allow_when_gitleaks_failed():
    report = scan_full_repository(FIXTURES / "safe", semgrep_runner=semgrep_runner(), gitleaks_runner=runner(code=1))
    report["decision"] = "ALLOW"
    with pytest.raises(jsonschema.ValidationError):
        validate(report)


def test_local_config_uses_embedded_rules_and_an_explicit_fake_token_namespace():
    config = tomllib.loads(gitleaks.CONFIG_FILE.read_text(encoding="utf-8"))
    assert config["extend"] == {"useDefault": True}
    assert config["rules"][0]["id"] == RULE
    assert config["rules"][0]["keywords"] == ["SGLAB_FAKE_TOKEN_"]
