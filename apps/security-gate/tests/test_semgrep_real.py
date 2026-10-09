"""Real Semgrep CLI tests; skip explicitly when the optional CLI is absent."""
from pathlib import Path

import pytest

from security_gate.semgrep import find_executable, scan_semgrep
from security_gate.gate import scan_repository

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "semgrep"
pytestmark = [pytest.mark.semgrep_real,
              pytest.mark.skipif(find_executable() is None, reason="Real Semgrep CLI is not installed in project .venv")]


def test_real_vulnerable_patterns_detected():
    report = scan_semgrep(FIXTURES / "vulnerable")
    assert report["decision"] == "DENY", report
    assert report["scan_status"] == "SUCCESS"
    assert {f["rule_id"] for f in report["findings"]} == {
        "security-gate-python-eval", "security-gate-python-shell-true"}
    assert {f["line"] for f in report["findings"]} == {5, 9}


def test_real_safe_patterns_allow():
    report = scan_semgrep(FIXTURES / "safe")
    assert report["decision"] == "ALLOW", report
    assert report["scanned_files"] == 1


def test_real_parse_failure_never_allows():
    report = scan_semgrep(FIXTURES / "invalid")
    assert report["decision"] == "SCAN_FAILED", report
    assert report["scan_status"] == "FAILED"
    assert report["errors"] == ["SOURCE_SYNTAX_INVALID"]


def test_real_integrated_report():
    report = scan_repository(FIXTURES / "vulnerable")
    assert report["decision"] == "DENY", report
    assert report["docker_compose"]["decision"] == "ALLOW"
    assert report["semgrep"]["decision"] == "DENY"


def test_real_java_safe_without_compose():
    report = scan_repository(FIXTURES / "java_safe")
    assert report["decision"] == "ALLOW", report
    assert report["docker_compose"]["scan_status"] == "NOT_APPLICABLE"
    assert report["semgrep"]["scanned_files"] == 1
    assert report["semgrep"]["detected_languages"] == ["java"]


def test_real_java_direct_typed_and_qualified_execution():
    report = scan_semgrep(FIXTURES / "java_vulnerable")
    assert report["decision"] == "DENY", report
    assert report["scan_status"] == "SUCCESS"
    assert {f["rule_id"] for f in report["findings"]} == {
        "security-gate-java-runtime-exec", "security-gate-java-process-builder"}
    assert {f["line"] for f in report["findings"]} == {5, 6, 8, 10, 11, 12}


def test_real_java_and_python_are_both_scanned(tmp_path):
    import shutil
    shutil.copy(FIXTURES / "java_safe" / "BoardService.java", tmp_path)
    shutil.copy(FIXTURES / "safe" / "sample.py", tmp_path)
    report = scan_semgrep(tmp_path)
    assert report["decision"] == "ALLOW", report
    assert report["scanned_files"] == 2
    assert report["detected_languages"] == ["java", "python"]


def test_real_java_parse_error_is_scan_failed(tmp_path):
    # Prove the engine can scan before attributing a failure to bad Java.
    healthy = scan_semgrep(FIXTURES / "java_safe")
    assert healthy["decision"] == "ALLOW", healthy
    (tmp_path / "Broken.java").write_text("class Broken { void broken( {", encoding="utf-8")
    report = scan_semgrep(tmp_path)
    assert report["decision"] == "SCAN_FAILED", report
