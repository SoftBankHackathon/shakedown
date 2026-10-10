"""Adapter tests with fabricated CLI output; these do not verify Semgrep detection."""
import copy
from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess
import time
from pathlib import Path
from threading import Barrier, Lock
from types import SimpleNamespace

import jsonschema
import pytest
import yaml
from referencing import Registry, Resource

from security_gate import semgrep, source_targets
from security_gate.gate import scan_repository
from security_gate.models import ScanError

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "semgrep"
SCHEMA = json.loads((ROOT / "security_gate" / "gate.schema.json").read_text(encoding="utf-8"))
DOCKER_SCHEMA = json.loads((ROOT / "security_gate" / "report.schema.json").read_text(encoding="utf-8"))
REGISTRY = Registry().with_resource("urn:security-gate:docker-report:v1", Resource.from_contents(DOCKER_SCHEMA))


def validate(report):
    jsonschema.Draft202012Validator(SCHEMA, registry=REGISTRY).validate(report)
    return report


def output_runner(*, findings=False, errors=False, returncode=None, edit=None, calls=None):
    def runner(command, **kwargs):
        if calls is not None:
            calls.append((command, kwargs))
        names = command[command.index("--") + 1:]
        payload = {"results": [], "errors": [], "paths": {"scanned": names}}
        if findings:
            for rule, line in [("security-gate-python-eval", 5), ("security-gate-python-shell-true", 9)]:
                payload["results"].append({"check_id": rule, "path": names[0], "start": {"line": line},
                    "extra": {"message": "PRIVATE_SENTINEL_VALUE", "lines": "SECRET_SOURCE",
                              "metavars": {"$X": {"abstract_content": "PRIVATE_SENTINEL_VALUE"}}}})
        if errors:
            payload["errors"] = [{"message": "PRIVATE_SENTINEL_VALUE"}]
        if edit:
            edit(payload)
        return subprocess.CompletedProcess(command, (1 if findings else 0) if returncode is None else returncode,
                                           json.dumps(payload).encode(), b"PRIVATE_SENTINEL_VALUE")
    return runner


def test_mock_findings_are_filtered_and_mapped_to_original_paths():
    report = semgrep.scan_semgrep(FIXTURES / "vulnerable", runner=output_runner(findings=True))
    assert report["decision"] == "DENY"
    assert report["scanned_files"] == 1
    assert {f["rule_id"] for f in report["findings"]} == {r for r in semgrep.RULES if "python" in r}
    assert [f["line"] for f in report["findings"]] == [5, 9]
    assert all(f["file_path"] == str(FIXTURES / "vulnerable" / "sample.py") for f in report["findings"])
    assert all(set(f) == {"tool", "rule_id", "severity", "file_path", "line", "decision", "reason_code"}
               for f in report["findings"])
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(report)
    assert "SECRET_SOURCE" not in json.dumps(report)


def test_mock_clean_success():
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner())
    assert report["decision"] == "ALLOW"
    assert report["scanned_files"] == 1


def test_bundled_rules_are_local_python_patterns_without_validators():
    data = yaml.safe_load(semgrep.RULE_FILE.read_text(encoding="utf-8"))
    assert {rule["id"] for rule in data["rules"]} == {r for r in semgrep.RULES if "python" in r}
    allowed = {"id", "languages", "severity", "message", "pattern", "pattern-either"}
    assert all(set(rule) <= allowed and rule["languages"] == ["python"] for rule in data["rules"])


def test_integrated_cli_uses_mock_adapter_and_version2(monkeypatch, capsys):
    from security_gate import cli, gate
    original = gate.scan_repository
    def integrated(target, **kwargs):
        return original(target, semgrep_runner=output_runner(), **kwargs)
    monkeypatch.setattr(gate, "scan_repository", integrated)
    assert cli.main([str(FIXTURES / "safe"), "--with-semgrep"]) == 0
    report = validate(json.loads(capsys.readouterr().out))
    assert report["schema_version"] == "2.0"


@pytest.mark.parametrize("failure,code", [
    (FileNotFoundError("PRIVATE_SENTINEL_VALUE"), "SEMGREP_IO_FAILED"),
    (subprocess.TimeoutExpired("PRIVATE_SENTINEL_VALUE", 1), "SEMGREP_TIMEOUT"),
    (RuntimeError("PRIVATE_SENTINEL_VALUE"), "SEMGREP_INTERNAL_ERROR"),
])
def test_mock_runner_exceptions_fail_closed(failure, code):
    def runner(*args, **kwargs):
        raise failure
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=runner)
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == [code]
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(report)


@pytest.mark.parametrize("exit_code", [1, 2, 7, -9])
def test_mock_execution_errors_never_allow(exit_code):
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner(returncode=exit_code))
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["SEMGREP_EXECUTION_FAILED"]


@pytest.mark.parametrize("raw", [b"PRIVATE_SENTINEL_VALUE", b"", b"\xff"])
def test_mock_invalid_json(raw):
    def runner(command, **kwargs):
        return subprocess.CompletedProcess(command, 0, raw, b"")
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=runner)
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["SEMGREP_INVALID_JSON"]
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(report)


@pytest.mark.parametrize("edit,code", [
    (lambda p: p.pop("errors"), "SEMGREP_INVALID_RESULT"),
    (lambda p: p.update(results={}), "SEMGREP_INVALID_RESULT"),
    (lambda p: p["paths"].update(scanned=[]), "SEMGREP_INCOMPLETE_SCAN"),
    (lambda p: p["paths"].update(scanned=["../PRIVATE_SENTINEL_VALUE.py"]), "SEMGREP_UNEXPECTED_RESULT_PATH"),
    (lambda p: p["results"][0].update(check_id="PRIVATE_SENTINEL_VALUE"), "SEMGREP_UNKNOWN_RULE"),
    (lambda p: p["results"][0].update(start={"line": True}), "SEMGREP_INVALID_RESULT"),
])
def test_mock_invalid_or_incomplete_result(edit, code):
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner(findings=True, edit=edit))
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == [code]
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(report)


def test_mock_scan_errors_keep_findings_but_fail_closed():
    report = semgrep.scan_semgrep(FIXTURES / "vulnerable", runner=output_runner(findings=True, errors=True))
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["SEMGREP_SCAN_ERRORS"]
    assert len(report["findings"]) == 2


def test_missing_executable_fails_closed(monkeypatch):
    monkeypatch.setattr(semgrep, "find_executable", lambda: None)
    report = semgrep.scan_semgrep(FIXTURES / "safe")
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["SEMGREP_NOT_INSTALLED"]


def test_no_python_files_is_review_and_runner_is_not_called(tmp_path):
    def runner(*args, **kwargs):
        pytest.fail("Runner must not run without applicable files")
    report = semgrep.scan_semgrep(tmp_path, runner=runner)
    assert report["decision"] == "REVIEW"
    assert report["scan_status"] == "NOT_APPLICABLE"


def test_invalid_source_path_fails_closed(tmp_path):
    assert semgrep.scan_semgrep(tmp_path / "missing", runner=output_runner())["decision"] == "SCAN_FAILED"
    assert semgrep.scan_semgrep(FIXTURES / "safe" / "sample.py", runner=output_runner())["decision"] == "SCAN_FAILED"


def test_command_uses_only_local_rules_and_isolated_sources(monkeypatch):
    monkeypatch.setenv("SEMGREP_APP_TOKEN", "PRIVATE_SENTINEL_VALUE")
    monkeypatch.setenv("SEMGREP_RULES", "auto")
    monkeypatch.setenv("PYTHONPATH", "PRIVATE_SENTINEL_VALUE")
    calls = []
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner(calls=calls))
    command, kwargs = calls[0]
    assert command[command.index("--config") + 1] == str(semgrep.RULE_FILE)
    assert command[command.index("--metrics") + 1] == "off"
    assert "--disable-version-check" in command
    assert "--oss-only" in command and "--no-git-ignore" in command
    assert "--autofix" not in command and "--allow-local-builds" not in command
    assert "SEMGREP_APP_TOKEN" not in kwargs["env"] and "SEMGREP_RULES" not in kwargs["env"]
    assert "PYTHONPATH" not in kwargs["env"]
    assert kwargs["cwd"] == ROOT
    source_paths = [Path(path) for path in command[command.index("--") + 1:]]
    assert all(path.is_absolute() and path.parent.is_relative_to(ROOT / ".tmp") for path in source_paths)
    assert all(not path.exists() for path in source_paths)  # snapshot removed
    assert kwargs["env"] == semgrep.environment(ROOT / ".tmp")
    assert report["decision"] == "ALLOW"


def test_default_cli_matches_working_probe_arguments(monkeypatch):
    calls = []
    monkeypatch.setattr(semgrep, "find_executable", lambda: "mock-semgrep")
    monkeypatch.setattr(semgrep, "run_cli", output_runner(calls=calls))
    report = semgrep.scan_semgrep(FIXTURES / "safe")
    probe_calls = []
    probe_report = semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner(calls=probe_calls))
    command, kwargs = calls[0]
    probe_command, probe_kwargs = probe_calls[0]
    assert kwargs["cwd"] == ROOT
    assert kwargs["env"] == semgrep.environment(ROOT / ".tmp")
    assert command[:command.index("--")] == probe_command[:probe_command.index("--")]
    assert kwargs["cwd"] == probe_kwargs["cwd"] and kwargs["env"] == probe_kwargs["env"]
    assert command[:2] == [semgrep.find_executable() or "mock-semgrep", "scan"]
    assert len(command[command.index("--") + 1:]) == 1
    assert Path(command[-1]).is_absolute()
    assert Path(command[-1]).parent.is_relative_to(ROOT / ".tmp")
    assert Path(command[-1]).name == Path(probe_command[-1]).name
    assert report["decision"] == "ALLOW" and report["scanned_files"] == 1
    assert probe_report["decision"] == "ALLOW"


def test_parallel_scans_have_separate_source_snapshots():
    barrier = Barrier(2)
    lock = Lock()
    snapshots = []

    def runner(command, **kwargs):
        snapshot = Path(command[command.index("--") + 1]).parent
        assert kwargs["cwd"] == ROOT
        assert kwargs["env"] == semgrep.environment(ROOT / ".tmp")
        assert all(Path(path).parent == snapshot for path in command[command.index("--") + 1:])
        with lock:
            snapshots.append(snapshot)
        barrier.wait(timeout=10)
        return output_runner()(command, **kwargs)

    with ThreadPoolExecutor(max_workers=2) as pool:
        reports = list(pool.map(lambda _: semgrep.scan_semgrep(FIXTURES / "safe", runner=runner), range(2)))
    assert [report["decision"] for report in reports] == ["ALLOW", "ALLOW"]
    assert len(set(snapshots)) == 2
    assert all(not snapshot.exists() for snapshot in snapshots)


def test_default_cli_serializes_shared_runtime(monkeypatch):
    lock = Lock()
    start = Barrier(2)
    active = 0
    peak = 0

    def fake_cli(command, **kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(0.1)
            return output_runner()(command, **kwargs)
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(semgrep, "find_executable", lambda: "mock-semgrep")
    monkeypatch.setattr(semgrep, "run_cli", fake_cli)
    def scan(_):
        start.wait(timeout=10)
        return semgrep.scan_semgrep(FIXTURES / "safe")
    with ThreadPoolExecutor(max_workers=2) as pool:
        reports = list(pool.map(scan, range(2)))
    assert [report["decision"] for report in reports] == ["ALLOW", "ALLOW"]
    assert peak == 1


@pytest.mark.skipif(os.name != "nt", reason="Windows profile handling")
def test_windows_semgrep_environment_keeps_native_profile_and_local_work_files(monkeypatch, tmp_path):
    profile = tmp_path / "native-profile"
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    monkeypatch.setenv("USERPROFILE", str(profile))
    monkeypatch.setenv("SEMGREP_APP_TOKEN", "PRIVATE_SENTINEL_VALUE")
    env = semgrep.environment(snapshot)
    assert env["USERPROFILE"] == str(profile)
    assert "HOME" not in env
    assert (snapshot / ".config").is_dir() and (snapshot / ".cache").is_dir()
    assert env["APPDATA"] == str(snapshot / ".config")
    assert env["LOCALAPPDATA"] == str(snapshot / ".cache")
    assert env["TEMP"] == str(snapshot) and env["TMP"] == str(snapshot)
    assert env["SEMGREP_SETTINGS_FILE"] == str(snapshot / "settings.yml")
    assert "SEMGREP_APP_TOKEN" not in env


def test_mock_secrets_and_target_configuration_are_not_executed(tmp_path):
    (tmp_path / "sample.py").write_text("raise RuntimeError('PRIVATE_SENTINEL_VALUE')", encoding="utf-8")
    (tmp_path / ".semgrepignore").write_text("*", encoding="utf-8")
    (tmp_path / ".semgrep.yml").write_text("PRIVATE_SENTINEL_VALUE", encoding="utf-8")
    def runner(command, **kwargs):
        snapshot = Path(command[command.index("--") + 1]).parent
        assert not (snapshot / ".semgrep.yml").exists()
        assert (snapshot / ".semgrepignore").read_text() == ""
        return output_runner()(command, **kwargs)
    assert semgrep.scan_semgrep(tmp_path, runner=runner)["decision"] == "ALLOW"


@pytest.mark.parametrize("limits", [{"timeout_seconds": 0}, {"timeout_seconds": float("nan")},
                                    {"timeout_seconds": 121}, {"max_file_bytes": True}])
def test_invalid_limits(limits):
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner(), **limits)
    assert report["errors"] == ["INVALID_SCAN_LIMITS"]


def test_source_size_limit():
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner(), max_file_bytes=1)
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["FILE_SIZE_LIMIT_EXCEEDED"]


def test_source_discovery_and_total_size_limits(monkeypatch):
    monkeypatch.setattr(source_targets, "MAX_FILES", 0)
    assert semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner())["decision"] == "SCAN_FAILED"
    monkeypatch.setattr(source_targets, "MAX_FILES", 256)
    monkeypatch.setattr(source_targets, "MAX_TOTAL_BYTES", 1)
    assert semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner())["decision"] == "SCAN_FAILED"


def test_mock_output_and_finding_limits(monkeypatch):
    monkeypatch.setattr(semgrep, "MAX_OUTPUT_BYTES", 1)
    assert semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner())["errors"] == ["SEMGREP_OUTPUT_LIMIT_EXCEEDED"]
    monkeypatch.setattr(semgrep, "MAX_OUTPUT_BYTES", 8 * 1024 * 1024)
    monkeypatch.setattr(semgrep, "MAX_FINDINGS", 1)
    assert semgrep.scan_semgrep(FIXTURES / "safe", runner=output_runner(findings=True))["errors"] == ["SEMGREP_FINDING_LIMIT_EXCEEDED"]


@pytest.mark.parametrize("findings,errors,decision", [(False, False, "ALLOW"), (True, False, "DENY"),
                                                     (False, True, "SCAN_FAILED"), (True, True, "SCAN_FAILED")])
def test_mock_integrated_report_preserves_step1_contract(findings, errors, decision):
    report = validate(scan_repository(FIXTURES / "safe", semgrep_runner=output_runner(findings=findings, errors=errors)))
    assert report["decision"] == decision
    assert report["docker_compose"]["schema_version"] == "1.0"
    assert report["docker_compose"]["decision"] == "ALLOW"
    assert report["semgrep"]["tool"] == "semgrep"


def test_mock_docker_and_semgrep_findings_both_preserved(tmp_path):
    (tmp_path / "compose.yaml").write_text("services:\n  admin:\n    privileged: true\n", encoding="utf-8")
    (tmp_path / "sample.py").write_text("eval(user_input)", encoding="utf-8")
    report = validate(scan_repository(tmp_path, semgrep_runner=output_runner(findings=True)))
    assert report["decision"] == "DENY"
    assert {f["tool"] for f in report["findings"]} == {"docker_compose", "semgrep"}
    assert report["docker_compose"]["files"][0]["findings"][0]["service"] == "admin"


def test_mock_docker_failure_prevents_integrated_allow(tmp_path):
    (tmp_path / "compose.yaml").write_text("services: [", encoding="utf-8")
    (tmp_path / "sample.py").write_text("pass", encoding="utf-8")
    report = validate(scan_repository(tmp_path, semgrep_runner=output_runner()))
    assert report["semgrep"]["decision"] == "ALLOW"
    assert report["decision"] == "SCAN_FAILED"


def test_mock_no_compose_keeps_step1_review_but_allows_applicable_source(tmp_path):
    (tmp_path / "sample.py").write_text("pass", encoding="utf-8")
    report = validate(scan_repository(tmp_path, semgrep_runner=output_runner()))
    assert report["decision"] == "ALLOW"
    assert report["docker_compose"]["decision"] == "REVIEW"
    assert report["docker_compose"]["scan_status"] == "NOT_APPLICABLE"


def test_schema_rejects_allow_when_required_scan_failed():
    report = scan_repository(FIXTURES / "safe", semgrep_runner=output_runner(errors=True))
    report = copy.deepcopy(report)
    report["decision"] = "ALLOW"
    with pytest.raises(jsonschema.ValidationError):
        validate(report)


def test_runner_spools_output_and_uses_no_shell(tmp_path, monkeypatch):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    original_temporary_file = semgrep.tempfile.TemporaryFile
    spool_dirs = []
    def temporary_file(*args, **kwargs):
        spool_dirs.append(kwargs.get("dir"))
        return original_temporary_file(*args, **kwargs)
    monkeypatch.setattr(semgrep.tempfile, "TemporaryFile", temporary_file)
    def popen(command, **kwargs):
        assert kwargs["shell"] is False and kwargs["stdin"] == subprocess.DEVNULL
        kwargs["stdout"].write(b'{"results": []}')
        kwargs["stdout"].flush()
        return SimpleNamespace(returncode=0, wait=lambda **kw: 0, poll=lambda: 0)
    monkeypatch.setattr(semgrep.subprocess, "Popen", popen)
    completed = semgrep.run_cli(["mock"], cwd=tmp_path, env={"TMPDIR": str(output_dir)}, timeout=1)
    assert completed.stdout == b'{"results": []}'
    assert spool_dirs == [str(output_dir), str(output_dir)]


def test_runner_output_limit_stops_process(tmp_path, monkeypatch):
    stopped = []
    monkeypatch.setattr(semgrep, "MAX_OUTPUT_BYTES", 4)
    def popen(command, **kwargs):
        kwargs["stdout"].write(b"PRIVATE_SENTINEL_VALUE")
        kwargs["stdout"].flush()
        return SimpleNamespace(returncode=None, poll=lambda: None)
    monkeypatch.setattr(semgrep.subprocess, "Popen", popen)
    monkeypatch.setattr(semgrep, "_stop", lambda process, cwd: stopped.append(True))
    with pytest.raises(ScanError, match="SEMGREP_OUTPUT_LIMIT_EXCEEDED"):
        semgrep.run_cli(["mock"], cwd=tmp_path, env={}, timeout=1)
    assert stopped == [True]


def test_runner_timeout_stops_process(tmp_path, monkeypatch):
    stopped = []
    monkeypatch.setattr(semgrep.subprocess, "Popen", lambda *args, **kw: SimpleNamespace(poll=lambda: None))
    monkeypatch.setattr(semgrep, "_stop", lambda process, cwd: stopped.append(True))
    with pytest.raises(subprocess.TimeoutExpired):
        semgrep.run_cli(["mock"], cwd=tmp_path, env={}, timeout=-1)
    assert stopped == [True]
