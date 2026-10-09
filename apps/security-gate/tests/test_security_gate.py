import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
from types import SimpleNamespace

import jsonschema
import pytest

from security_gate import scan
from security_gate import discovery, parsing, scanner
from security_gate.models import ScanError

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
SCHEMA = json.loads((ROOT / "security_gate" / "report.schema.json").read_text(encoding="utf-8"))


def validate(result):
    jsonschema.Draft202012Validator(SCHEMA).validate(json.loads(json.dumps(result)))
    return result


def compose(tmp_path, source, name="compose.yaml"):
    path = tmp_path / name
    path.write_text(source, encoding="utf-8")
    return path


@pytest.mark.parametrize("fixture,decision", [
    ("safe", "ALLOW"), ("deny", "DENY"), ("multi", "DENY"),
    ("dynamic", "REVIEW"), ("malformed", "SCAN_FAILED"),
    ("alias", "SCAN_FAILED"), ("tag", "SCAN_FAILED"), ("duplicate", "SCAN_FAILED"),
])
def test_fixture_decisions_and_json_schema(fixture, decision):
    result = validate(scan(FIXTURES / fixture))
    assert result["decision"] == decision
    assert result["scan_status"] == ("FAILED" if decision == "SCAN_FAILED" else "SUCCESS")


def test_deny_evidence_location():
    result = scan(FIXTURES / "deny")
    finding = result["files"][0]["findings"][0]
    assert finding == {
        "decision": "DENY", "file_path": str(FIXTURES / "deny" / "docker-compose.yml"),
        "service": "admin", "rule_id": "DOCKER_COMPOSE_PRIVILEGED",
        "reason_code": "PRIVILEGED_ENABLED",
        "location": {"line": 4, "column": 17, "path": ["services", "admin", "privileged"]},
    }


def test_multiservice_reports_only_risk_and_uncertainty():
    findings = scan(FIXTURES / "multi")["files"][0]["findings"]
    assert [(f["service"], f["decision"]) for f in findings] == [
        ("admin", "DENY"), ("worker", "REVIEW")]


@pytest.mark.parametrize("name", sorted(discovery.COMPOSE_NAMES))
def test_all_compose_names_recursive_and_direct(tmp_path, name):
    nested = tmp_path / "nested"
    nested.mkdir()
    path = compose(nested, "services:\n  web:\n    privileged: false\n", name)
    assert scan(tmp_path)["decision"] == "ALLOW"
    assert scan(path)["decision"] == "ALLOW"


@pytest.mark.parametrize("value,decision", [
    ("true", "DENY"), ('"true"', "DENY"), ("false", "ALLOW"),
    ('"false"', "REVIEW"), ("null", "REVIEW"), ("1", "REVIEW"),
    ("0", "REVIEW"), ("[]", "REVIEW"), ("{}", "REVIEW"),
])
def test_privileged_value_classification(tmp_path, value, decision):
    path = compose(tmp_path, f"services:\n  web:\n    privileged: {value}\n")
    assert validate(scan(path))["decision"] == decision


def test_no_files_is_not_applicable_and_review_and_never_executes_scripts(tmp_path):
    script = tmp_path / "untrusted.py"
    script.write_text("raise RuntimeError('must never run')", encoding="utf-8")
    result = validate(scan(tmp_path))
    assert result["scan_status"] == "NOT_APPLICABLE"
    assert result["decision"] == "REVIEW"
    assert result["files"] == []
    assert scan(script)["decision"] == "REVIEW"


def test_nonexistent_path_fails_closed(tmp_path):
    result = validate(scan(tmp_path / "missing"))
    assert result["decision"] == "SCAN_FAILED"
    assert result["errors"] == ["PATH_ACCESS_FAILED"]


@pytest.mark.parametrize("source", [
    "", "[]", "services: []", "services: {}", "services:\n  web: null",
    "services:\n  true: {}", "services:\n  web: []",
])
def test_invalid_compose_structure_never_allows(tmp_path, source):
    assert scan(compose(tmp_path, source))["decision"] == "SCAN_FAILED"


def test_one_failed_file_overrides_allow_and_deny(tmp_path):
    shutil.copy(FIXTURES / "deny" / "docker-compose.yml", tmp_path)
    shutil.copy(FIXTURES / "safe" / "compose.yaml", tmp_path)
    compose(tmp_path, "services: [", "compose.yml")
    result = validate(scan(tmp_path))
    assert result["decision"] == "SCAN_FAILED"
    assert {f["decision"] for f in result["files"]} == {"ALLOW", "DENY", "SCAN_FAILED"}
    assert any(f["findings"] for f in result["files"])


@pytest.mark.parametrize("fixture", ["dynamic", "tag"])
def test_reports_omit_source_values(fixture):
    serialized = json.dumps(scan(FIXTURES / fixture))
    assert "PRIVATE_SENTINEL_VALUE" not in serialized
    assert "os.system" not in serialized
    assert "example/" not in serialized


def test_malformed_yaml_does_not_echo_secret(tmp_path):
    path = compose(tmp_path, "services:\n  web:\n    privileged: [PRIVATE_SENTINEL_VALUE\n")
    result = scan(path)
    assert result["decision"] == "SCAN_FAILED"
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(result)


def test_file_size_limit(tmp_path):
    path = compose(tmp_path, "services:\n  web:\n    privileged: false\n" + "#" * 128)
    result = validate(scan(path, max_file_bytes=64))
    assert result["decision"] == "SCAN_FAILED"
    assert result["files"][0]["error"] == "FILE_SIZE_LIMIT_EXCEEDED"


def test_invalid_encoding(tmp_path):
    path = tmp_path / "compose.yaml"
    path.write_bytes(b"\xff\xfe\x00")
    assert scan(path)["decision"] == "SCAN_FAILED"


def test_yaml_depth_limit(tmp_path):
    source = "services:\n  web:\n    privileged: " + "[" * 70 + "true" + "]" * 70
    result = scan(compose(tmp_path, source))
    assert result["decision"] == "SCAN_FAILED"
    assert result["files"][0]["error"] == "YAML_COMPLEXITY_LIMIT_EXCEEDED"


def test_timeout_fails_closed():
    result = validate(scan(FIXTURES / "safe", timeout_seconds=0.000001))
    assert result["decision"] == "SCAN_FAILED"
    assert result["errors"] == ["TIME_LIMIT_EXCEEDED"]


@pytest.mark.parametrize("limits", [
    {"timeout_seconds": 0}, {"timeout_seconds": float("nan")},
    {"timeout_seconds": 61}, {"max_file_bytes": 0}, {"max_file_bytes": True},
])
def test_invalid_limits_fails_closed(limits):
    result = scan(FIXTURES / "safe", **limits)
    assert result["decision"] == "SCAN_FAILED"
    assert result["errors"] == ["INVALID_SCAN_LIMITS"]


def test_read_failure_is_separate_from_allow(tmp_path, monkeypatch):
    path = compose(tmp_path, "services:\n  web: {}")
    def fail_open(*args, **kwargs):
        raise PermissionError("PRIVATE_SENTINEL_VALUE")
    monkeypatch.setattr(parsing.os, "open", fail_open)
    result = scanner._scan_local(path, 1024)
    assert result["decision"] == "SCAN_FAILED"
    assert result["files"][0]["error"] == "FILE_READ_FAILED"
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(result)


def test_unexpected_worker_exception_fails_closed(monkeypatch):
    captured = []
    def fail(*args):
        raise RuntimeError("PRIVATE_SENTINEL_VALUE")
    monkeypatch.setattr(scanner, "_scan_local", fail)
    connection = SimpleNamespace(send=captured.append, close=lambda: None)
    scanner._worker(str(FIXTURES / "safe"), 1024, connection)
    assert captured[0]["decision"] == "SCAN_FAILED"
    assert captured[0]["errors"] == ["INTERNAL_SCAN_ERROR"]
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(captured)


def test_worker_setup_failure_fails_closed(monkeypatch):
    def fail_context(*args):
        raise OSError("PRIVATE_SENTINEL_VALUE")
    monkeypatch.setattr(scanner.multiprocessing, "get_context", fail_context)
    result = validate(scan(FIXTURES / "safe"))
    assert result["decision"] == "SCAN_FAILED"
    assert result["errors"] == ["WORKER_FAILED"]
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(result)


def test_worker_closed_transport_does_not_emit_traceback():
    def fail_send(result):
        raise BrokenPipeError("PRIVATE_SENTINEL_VALUE")
    scanner._worker(str(FIXTURES / "safe"), 1024,
                    SimpleNamespace(send=fail_send, close=lambda: None))


def test_reparse_attribute_is_unsafe():
    metadata = SimpleNamespace(st_mode=stat.S_IFDIR,
                               st_file_attributes=getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024))
    if not hasattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT"):
        pytest.skip("Windows reparse attributes are unavailable")
    assert discovery.is_link(metadata)


@pytest.mark.parametrize("kind", ["file", "directory", "ancestor"])
def test_real_symlink_fails_closed(tmp_path, kind):
    actual = tmp_path / "actual"
    actual.mkdir()
    compose(actual, "services:\n  web:\n    privileged: false\n")
    link = tmp_path / ("compose.yaml" if kind == "file" else "linked")
    try:
        os.symlink(actual / "compose.yaml" if kind == "file" else actual,
                   link, target_is_directory=kind != "file")
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"Symlink creation unavailable; no elevation attempted ({type(exc).__name__})")
    target = link / "compose.yaml" if kind == "ancestor" else tmp_path
    result = validate(scan(target))
    assert result["decision"] == "SCAN_FAILED"
    assert result["errors"] == ["SYMLINK_OR_REPARSE_POINT"]


def test_discovery_entry_limit_fails_closed(tmp_path, monkeypatch):
    compose(tmp_path, "services:\n  web: {}")
    monkeypatch.setattr(discovery, "MAX_ENTRIES", 0)
    with pytest.raises(ScanError, match="DISCOVERY_LIMIT_EXCEEDED"):
        discovery.discover(tmp_path)


def test_total_size_and_finding_limits_fail_closed(tmp_path, monkeypatch):
    path = compose(tmp_path, "services:\n  web:\n    privileged: true\n")
    monkeypatch.setattr(scanner, "MAX_TOTAL_FILE_BYTES", 1)
    assert scanner._scan_local(path, 1024)["decision"] == "SCAN_FAILED"
    monkeypatch.setattr(scanner, "MAX_TOTAL_FILE_BYTES", 1024)
    monkeypatch.setattr(scanner, "MAX_TOTAL_FINDINGS", 0)
    assert scanner._scan_local(path, 1024)["decision"] == "SCAN_FAILED"


@pytest.mark.parametrize("fixture,exit_code", [
    ("safe", 0), ("deny", 1), ("dynamic", 2), ("malformed", 3),
])
def test_cli_json_and_exit_codes(fixture, exit_code):
    completed = subprocess.run([sys.executable, str(ROOT / "main.py"), str(FIXTURES / fixture)],
                               cwd=ROOT, capture_output=True, text=True, timeout=15)
    assert completed.returncode == exit_code
    assert completed.stderr == ""
    validate(json.loads(completed.stdout))


def test_module_cli():
    completed = subprocess.run([sys.executable, "-m", "security_gate", str(FIXTURES / "safe")],
                               cwd=ROOT, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0
    assert validate(json.loads(completed.stdout))["decision"] == "ALLOW"


def test_cli_timeout_json_without_traceback():
    completed = subprocess.run([
        sys.executable, str(ROOT / "main.py"), str(FIXTURES / "safe"),
        "--timeout-seconds", "0.000001",
    ], cwd=ROOT, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 3
    assert completed.stderr == ""
    assert validate(json.loads(completed.stdout))["errors"] == ["TIME_LIMIT_EXCEEDED"]
