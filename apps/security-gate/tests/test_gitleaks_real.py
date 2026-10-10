"""Real engine tests, explicitly separate from mocked CLI normalization."""
import json
from pathlib import Path

import pytest

from security_gate.gitleaks import find_executable, scan_gitleaks
from security_gate.gate3 import scan_full_repository

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "gitleaks"
FAKE = "SGLAB_FAKE_TOKEN_0123456789abcdefghijklmnop"
pytestmark = [pytest.mark.gitleaks_real,
              pytest.mark.skipif(find_executable() is None, reason="Real Gitleaks binary is not installed in project tools/gitleaks")]


def test_real_gitleaks_safe_text_is_clean():
    report = scan_gitleaks(FIXTURES / "safe")
    assert report["decision"] == "ALLOW", report
    assert report["version"] is not None


def test_real_gitleaks_artificial_token_detected_without_value_disclosure(capsys):
    report = scan_gitleaks(FIXTURES / "secret")
    assert report["decision"] == "DENY", report
    assert "security-gate-lab-api-token" in {f["rule_id"] for f in report["findings"]}
    assert FAKE not in json.dumps(report)
    output = capsys.readouterr()
    assert FAKE not in output.out + output.err


def test_real_three_tool_integration_denies_the_artificial_token():
    report = scan_full_repository(FIXTURES / "secret")
    assert report["docker_compose"]["decision"] == "ALLOW", report
    assert report["semgrep"]["decision"] == "ALLOW", report
    assert report["gitleaks"]["decision"] == "DENY", report
    assert report["decision"] == "DENY"
    assert FAKE not in json.dumps(report)
