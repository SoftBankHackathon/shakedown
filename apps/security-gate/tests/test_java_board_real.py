"""Optional read-only compatibility check against the team's existing sample."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

from security_gate import gitleaks, semgrep
from security_gate.parsing import read_bounded_bytes
from test_gitleaks import validate

ROOT = Path(__file__).resolve().parents[1]
BOARD = ROOT.parents[1] / "samples" / "kty-board"


def fingerprint():
    return {str(path.relative_to(BOARD)): hashlib.sha256(read_bounded_bytes(path, 1024 * 1024)).hexdigest()
            for path in sorted(BOARD.rglob("*")) if path.is_file()}


@pytest.mark.semgrep_real
@pytest.mark.gitleaks_real
@pytest.mark.skipif(not BOARD.is_dir() or semgrep.find_executable() is None or gitleaks.find_executable() is None,
                    reason="Requires existing samples/kty-board and both real local CLIs")
def test_real_board_read_only_compatibility(record_property):
    before = fingerprint()
    completed = subprocess.run([sys.executable, str(ROOT / "main.py"), str(BOARD), "--with-gitleaks"],
                               cwd=ROOT, capture_output=True, text=True, timeout=90)
    assert fingerprint() == before, "Sample project contents changed"
    assert completed.stderr == ""
    report = validate(json.loads(completed.stdout))
    record_property("security_gate_report", json.dumps(report))
    assert report["docker_compose"]["scan_status"] == "NOT_APPLICABLE"
    assert report["gitleaks"]["decision"] == "ALLOW", report["gitleaks"]["errors"]
    assert report["gitleaks"]["excluded_binary_files"] == 1
    assert report["semgrep"]["scan_status"] == "SUCCESS", report["semgrep"]["errors"]
    assert report["semgrep"]["scanned_files"] == len(list(BOARD.rglob("*.java"))) + 3
    assert report["semgrep"]["scanned_units"] == len(list(BOARD.rglob("*.java"))) + 6
    assert report["semgrep"]["scanned_languages"] == ["java", "javascript"]
    assert report["semgrep"]["unsupported_languages"] == []
    assert report["semgrep"]["coverage_gaps"] == ["EXTERNAL_SCRIPT_REFERENCE", "TEMPLATE_EXPRESSION"]
    # 시연 앱: 못 본 범위(CDN·Thymeleaf 표현식)는 보고만 하고 통과한다.
    assert report["decision"] == "ALLOW" and completed.returncode == 0
