"""Fail-closed bridge to the merged Security Gate v3 CLI.

Only summaries are exposed: scanner findings/logs can contain source secrets.
"""
import json
from pathlib import Path
import subprocess
import sys

from engine.image_builder import BuildError

GATE_ROOT = Path(__file__).resolve().parents[2] / 'security-gate'
CODES = {'ALLOW': 0, 'DENY': 1, 'REVIEW': 2, 'SCAN_FAILED': 3}


class SecurityGateError(BuildError):
    def __init__(self, decision):
        self.decision = decision
        super().__init__(f'Security Gate: {decision}. 보안 검사 ALLOW 결과가 필요합니다. '
                         '취약점·검토 필요 항목 또는 검사 도구 설치 상태를 확인하세요. 빌드·배포를 중단했습니다.')


def require_allow(root):
    try:
        result = subprocess.run(
            [sys.executable, str(GATE_ROOT / 'main.py'), str(root), '--with-gitleaks'],
            cwd=GATE_ROOT, capture_output=True, timeout=90, check=False,
        )
        report = json.loads(result.stdout)
        decision = report['decision']
        if (report['schema_version'] != '3.0' or decision not in CODES
                or result.returncode != CODES[decision]):
            raise ValueError('Invalid gate result')
        if decision == 'ALLOW' and (report.get('scan_status') != 'SUCCESS'
                or any(report.get(key, {}).get('decision') != 'ALLOW'
                       or report.get(key, {}).get('scan_status') != 'SUCCESS'
                       for key in ('docker_compose', 'semgrep', 'gitleaks'))):
            raise ValueError('Contradictory gate result')
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError):
        raise SecurityGateError('SCAN_FAILED') from None
    if decision != 'ALLOW':
        raise SecurityGateError(decision)
    return {'schema_version': '3.0', 'decision': 'ALLOW', 'scan_status': 'SUCCESS'}
