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
CODES = {'ALLOW': 0, 'DENY': 1, 'SCAN_FAILED': 3}
# 게이트는 통과(ALLOW) 아니면 차단이다. 근거 없는 차단은 Semgrep block_reasons로 이유를 알려 준다.
BLOCK_TEXT = {
    'NO_SCANNABLE_SOURCE': '검사할 소스가 없습니다',
    'UNSUPPORTED_SCRIPT_TYPE': '지원하지 않는 script 타입이 있습니다',
    'MALFORMED_TEMPLATE': 'HTML 템플릿 구조가 깨져 있어 스크립트를 검사할 수 없습니다',
}


class SecurityGateError(BuildError):
    def __init__(self, decision, report=None):
        self.decision = decision
        super().__init__(f'Security Gate: {decision}. {explain(report)} 빌드·배포를 중단했습니다.')


def explain(report):
    """요약만 만든다. 발견 내용·경로는 비밀을 담을 수 있어 내보내지 않는다."""
    if report is None or report['decision'] == 'SCAN_FAILED':
        return '검사 도구 설치·실행 상태를 확인하세요.'
    semgrep = report['semgrep']
    parts = ['보안 위험이 발견됐습니다. 해당 코드·설정을 고치세요'] if report['findings'] else []
    for reason in semgrep.get('block_reasons', []):
        parts.append(f'검사할 수 없는 언어가 있습니다({", ".join(semgrep["unsupported_languages"])}). '
                     f'검사 가능한 언어: {", ".join(scannable_languages())}' if reason == 'UNSUPPORTED_LANGUAGE'
                     else BLOCK_TEXT[reason])
    return '. '.join(parts) + '.'


@lru_cache(maxsize=1)
def schemas():
    """Resolve only the bundled schemas, never a remote or target-provided schema."""
    return [json.loads((GATE_ROOT / 'security_gate' / name).read_text())
            for name in ('report.schema.json', 'gate.schema.json', 'gate3.schema.json')]


def scannable_languages():
    # 게이트 계약(스키마)의 허용 목록을 그대로 쓴다.
    return schemas()[1]['$defs']['semgrep']['properties']['scanned_languages']['items']['enum']


@lru_cache(maxsize=1)
def report_validator():
    loaded = schemas()
    ids = ('urn:security-gate:docker-report:v1',
           'urn:security-gate:integrated-report:v2',
           'urn:security-gate:integrated-report:v3')
    registry = Registry().with_resources(
        (uri, Resource.from_contents(schema)) for uri, schema in zip(ids, loaded))
    return Draft202012Validator(loaded[-1], registry=registry)


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
            # 스키마가 이미 강제하지만, 승인 조건은 한 번 더 직접 확인한다.
            if (docker['decision'] != 'ALLOW' or docker['errors']
                    or any(report[key]['decision'] != 'ALLOW'
                           or report[key]['scan_status'] != 'SUCCESS'
                           for key in ('semgrep', 'gitleaks'))):
                raise ValueError('Contradictory gate result')
    except (ValidationError, OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError):
        raise SecurityGateError('SCAN_FAILED') from None
    if decision != 'ALLOW':
        raise SecurityGateError(decision, report)
    return {'schema_version': '3.0', 'decision': 'ALLOW', 'scan_status': 'SUCCESS'}
