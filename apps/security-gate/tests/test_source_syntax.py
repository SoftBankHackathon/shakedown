"""Real AST validation plus unit tests for validation and scan failure handling."""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest
import jsonschema
from referencing import Registry, Resource

from security_gate import semgrep, source_syntax, source_targets
from security_gate.gate import scan_repository
from security_gate.models import ScanError

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "semgrep"


@pytest.mark.parametrize("fixture", ["safe", "vulnerable"])
def test_real_ast_accepts_existing_valid_fixtures(fixture):
    _, inputs = source_targets.sources(FIXTURES / fixture, 1024 * 1024)
    source_syntax.validate_sources(inputs, timeout_seconds=5)


def test_real_ast_rejects_existing_invalid_fixture():
    _, inputs = source_targets.sources(FIXTURES / "invalid", 1024 * 1024)
    with pytest.raises(ScanError, match="^SOURCE_SYNTAX_INVALID$"):
        source_syntax.validate_sources(inputs, timeout_seconds=5)


@pytest.mark.parametrize("source", ["def incomplete(", "if True:\npass", "value = '\x00'",
                                    "value = " + "[" * 300 + "0" + "]" * 300])
def test_real_ast_invalid_source_never_approves(tmp_path, source):
    (tmp_path / "sample.py").write_text(source, encoding="utf-8")
    def runner(*args, **kwargs):
        pytest.fail("Semgrep must not run on syntax-invalid sources")
    report = semgrep.scan_semgrep(tmp_path, runner=runner)
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["SOURCE_SYNTAX_INVALID"]
    assert report["scan_status"] == "FAILED"
    assert report["scanned_files"] == 0


def test_syntax_failure_blocks_even_a_silent_successful_semgrep_runner():
    calls = []
    def silent_runner(command, **kwargs):
        calls.append(True)
        names = command[command.index("--") + 1:]
        return subprocess.CompletedProcess(command, 0, json.dumps({
            "results": [], "errors": [], "paths": {"scanned": names}}).encode(), b"")
    report = semgrep.scan_semgrep(FIXTURES / "invalid", runner=silent_runner)
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == ["SOURCE_SYNTAX_INVALID"]
    assert calls == []


def test_ast_does_not_execute_imports_functions_or_top_level_effects(tmp_path):
    marker = tmp_path / "must-not-exist.txt"
    source = f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\nwhile True: pass\n"
    source_syntax.validate_sources([(tmp_path / "sample.py", source)], timeout_seconds=5)
    assert not marker.exists()


def test_runtime_grammar_is_used_for_python_version_specific_syntax(tmp_path):
    inputs = [(tmp_path / "sample.py", "type Alias = int\n")]
    if sys.version_info >= (3, 12):
        source_syntax.validate_sources(inputs, timeout_seconds=5)
    else:
        with pytest.raises(ScanError, match="SOURCE_SYNTAX_INVALID"):
            source_syntax.validate_sources(inputs, timeout_seconds=5)


@pytest.mark.parametrize("failure,code", [
    (subprocess.TimeoutExpired("PRIVATE_SENTINEL_VALUE", 1), "SOURCE_SYNTAX_TIMEOUT"),
    (OSError("PRIVATE_SENTINEL_VALUE"), "SOURCE_SYNTAX_CHECK_FAILED"),
])
def test_ast_worker_errors_fail_closed_and_omit_details(monkeypatch, failure, code):
    def run(*args, **kwargs):
        raise failure
    monkeypatch.setattr(source_syntax.subprocess, "run", run)
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=lambda *a, **kw: pytest.fail("must not run"))
    assert report["decision"] == "SCAN_FAILED"
    assert report["errors"] == [code]
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(report)


@pytest.mark.parametrize("exit_code,code", [(65, "SOURCE_SYNTAX_INVALID"),
                                          (1, "SOURCE_SYNTAX_CHECK_FAILED"),
                                          (2, "SOURCE_SYNTAX_CHECK_FAILED"),
                                          (-9, "SOURCE_SYNTAX_CHECK_FAILED")])
def test_ast_worker_nonzero_exit_is_not_success(monkeypatch, exit_code, code):
    monkeypatch.setattr(source_syntax.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=exit_code))
    with pytest.raises(ScanError, match=f"^{code}$"):
        source_syntax.validate_sources([(Path("sample.py"), "pass")], timeout_seconds=1)


def test_ast_worker_has_isolated_imports_no_shell_and_no_target_paths(monkeypatch):
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(source_syntax.subprocess, "run", run)
    source_syntax.validate_sources([(Path("private-source.py"), "pass")], timeout_seconds=2)
    command, kwargs = calls[0]
    assert command[:5] == [sys.executable, "-I", "-S", "-B", "-c"]
    assert "private-source.py" not in " ".join(command)
    assert kwargs["shell"] is False
    assert kwargs["cwd"] == source_syntax.PROJECT_ROOT
    assert kwargs["stderr"] == subprocess.DEVNULL
    assert json.loads(kwargs["input"]) == ["pass"]


def test_ast_expired_budget_is_not_success():
    with pytest.raises(ScanError, match="SOURCE_SYNTAX_TIMEOUT"):
        source_syntax.validate_sources([(Path("sample.py"), "pass")], timeout_seconds=0)


def test_size_limit_applies_before_ast_validation(tmp_path, monkeypatch):
    (tmp_path / "sample.py").write_text("pass\n" * 100, encoding="utf-8")
    monkeypatch.setattr(semgrep, "validate_sources", lambda *a, **kw: pytest.fail("must not parse oversized input"))
    report = semgrep.scan_semgrep(tmp_path, max_file_bytes=16, runner=lambda *a, **kw: None)
    assert report["errors"] == ["FILE_SIZE_LIMIT_EXCEEDED"]


def test_link_rejection_applies_before_ast_validation(monkeypatch):
    monkeypatch.setattr(semgrep, "validate_sources", lambda *a, **kw: pytest.fail("must not parse unsafe input"))
    monkeypatch.setattr(source_targets, "is_link", lambda metadata: True)
    report = semgrep.scan_semgrep(FIXTURES / "safe", runner=lambda *a, **kw: None)
    assert report["errors"] == ["SYMLINK_OR_REPARSE_POINT"]


def test_syntax_error_does_not_echo_source_values(tmp_path):
    (tmp_path / "sample.py").write_text("value = 'PRIVATE_SENTINEL_VALUE", encoding="utf-8")
    report = semgrep.scan_semgrep(tmp_path, runner=lambda *a, **kw: None)
    assert report["errors"] == ["SOURCE_SYNTAX_INVALID"]
    assert "PRIVATE_SENTINEL_VALUE" not in json.dumps(report)


def test_integrated_syntax_failure_never_allows(tmp_path):
    (tmp_path / "compose.yaml").write_text("services:\n  app:\n    privileged: false\n", encoding="utf-8")
    (tmp_path / "sample.py").write_text("def incomplete(", encoding="utf-8")
    report = scan_repository(tmp_path, semgrep_runner=lambda *a, **kw: pytest.fail("must not run"))
    assert report["docker_compose"]["decision"] == "ALLOW"
    assert report["semgrep"]["errors"] == ["SOURCE_SYNTAX_INVALID"]
    assert report["decision"] == "SCAN_FAILED"
    schemas = Path(__file__).resolve().parents[1] / "security_gate"
    docker_schema = json.loads((schemas / "report.schema.json").read_text(encoding="utf-8"))
    gate_schema = json.loads((schemas / "gate.schema.json").read_text(encoding="utf-8"))
    registry = Registry().with_resource("urn:security-gate:docker-report:v1", Resource.from_contents(docker_schema))
    jsonschema.Draft202012Validator(gate_schema, registry=registry).validate(report)
