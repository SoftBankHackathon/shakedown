"""Fail-closed bridge to the merged Security Gate v3 CLI.

Only summaries are exposed: scanner findings/logs can contain source secrets.
"""
import json
from pathlib import Path
import subprocess
import sys
from functools import lru_cache

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource

from engine.image_builder import BuildError

GATE_ROOT = Path(__file__).resolve().parents[2] / 'security-gate'
CODES = {'ALLOW': 0, 'DENY': 1, 'REVIEW': 2, 'SCAN_FAILED': 3}


class SecurityGateError(BuildError):
    def __init__(self, decision):
        self.decision = decision
        super().__init__(f'Security Gate: {decision}. 보안 검사 ALLOW 결과가 필요합니다. '
                         '취약점·검토 필요 항목 또는 검사 도구 설치 상태를 확인하세요. 빌드·배포를 중단했습니다.')


@lru_cache(maxsize=1)
def report_validator():
    """Resolve only the bundled schemas, never a remote or target-provided schema."""
    schemas = [json.loads((GATE_ROOT / 'security_gate' / name).read_text())
               for name in ('report.schema.json', 'gate.schema.json', 'gate3.schema.json')]
    ids = ('urn:security-gate:docker-report:v1',
           'urn:security-gate:integrated-report:v2',
           'urn:security-gate:integrated-report:v3')
    registry = Registry().with_resources(
        (uri, Resource.from_contents(schema)) for uri, schema in zip(ids, schemas))
    return Draft202012Validator(schemas[-1], registry=registry)


def require_allow(root):
    try:
        result = subprocess.run(
            [sys.executable, str(GATE_ROOT / 'main.py'), str(root), '--with-gitleaks'],
            cwd=GATE_ROOT, capture_output=True, timeout=90, check=False,
        )
        report = json.loads(result.stdout)
        report_validator().validate(report)
        decision = report['decision']
        if (report['schema_version'] != '3.0' or decision not in CODES
                or result.returncode != CODES[decision]):
            raise ValueError('Invalid gate result')
        if decision == 'ALLOW':
            docker = report['docker_compose']
            compose_ok = (docker['decision'], docker['scan_status']) in {
                ('ALLOW', 'SUCCESS'), ('REVIEW', 'NOT_APPLICABLE')}
            if (not compose_ok or docker['errors']
                    or any(report[key]['decision'] != 'ALLOW'
                           or report[key]['scan_status'] != 'SUCCESS'
                           for key in ('semgrep', 'gitleaks'))):
                raise ValueError('Contradictory gate result')
    except (ValidationError, OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError):
        raise SecurityGateError('SCAN_FAILED') from None
    if decision != 'ALLOW':
        raise SecurityGateError(decision)
    return {'schema_version': '3.0', 'decision': 'ALLOW', 'scan_status': 'SUCCESS'}
