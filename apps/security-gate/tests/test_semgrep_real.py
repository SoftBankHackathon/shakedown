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
