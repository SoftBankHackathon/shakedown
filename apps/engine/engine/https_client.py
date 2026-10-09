"""Trusted HTTPS registry; the browser cannot choose cloud credentials or control endpoints."""
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx


class HttpsError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


def loopback_url(value):
    if not re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', value) or int(value.rsplit(':', 1)[1]) > 65535:
        raise HttpsError('내부 서비스 주소는 127.0.0.1의 명시적인 포트여야 합니다.')
    return value


def target_address(target, default):
    # Server configuration only, never populated from dashboard requests.
    return loopback_url(os.environ.get('SHAKEDOWN_TARGET_' + target.upper() + '_URL', default))


class HttpsClient:
    def __init__(self, base=None, transport=None):
        value = base if base is not None else os.environ.get('SHAKEDOWN_HTTPS_URL')
        self.base = loopback_url(value) if value else None
        self.transport = transport

    def call(self, method, project, target, body=None, recheck=False):
        if not self.base:
            raise HttpsError('HTTPS 서비스를 연결하세요. 기반 리소스 설정 후 9301 서비스를 실행해야 합니다.')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', project) or target not in {'aws', 'azure', 'gcp', 'local'}:
            raise HttpsError('잘못된 프로젝트 또는 배포 대상입니다.', 400)
        path = f'/projects/{project}/targets/{target}/https' + ('/recheck' if recheck else '')
        try:
            with httpx.Client(timeout=20, trust_env=False, transport=self.transport) as client:
                r = client.request(method, self.base + path, json=body)
                if not r.is_success:
                    if r.status_code == 404: raise HttpsError('등록된 HTTPS 연결이 없습니다.', 404)
                    message = {400:'도메인·요청 형식을 확인하세요.', 409:'HTTPS 변경이 진행 중이거나 다른 연결이 있습니다.',
                               422:'기반 리소스와 전용 계정 연결 설정이 필요합니다.'}.get(r.status_code, 'HTTPS 서비스를 확인하세요.')
                    raise HttpsError(message, r.status_code if r.status_code in {400,409,422} else 503)
                return r.json()
        except (httpx.HTTPError, ValueError):
            raise HttpsError('HTTPS 서비스에 연결할 수 없습니다. 기존 HTTP 주소로 자동 전환하지 않습니다.') from None

    def binding(self, project, target):
        if not self.base: return None
        try: return self.call('GET', project, target)
        except HttpsError as exc:
            if exc.status == 404: return None
            raise

    def deployment_url(self, project, target, reported, native_valid):
        b = self.binding(project, target)
        if not b:
            if not native_valid: raise HttpsError('등록되지 않은 배포 주소입니다.', 400)
            return reported
        u = urlsplit(b.get('https_url') or '')
        if (b.get('project_id') != project or b.get('target') != target or b.get('status') != 'ready'
                or u.scheme != 'https' or u.hostname != b.get('domain') or u.port or u.username or u.password
                or u.path not in {'', '/'} or u.query or u.fragment
                or not b.get('certificate') or not b.get('checked_at')):
            raise HttpsError('사용자 도메인의 HTTPS 검증을 완료한 뒤 시운전하세요.', 409)
        try:
            if datetime.fromisoformat(b['certificate']['expires_at'].replace('Z','+00:00')) <= datetime.now(timezone.utc):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise HttpsError('인증서 유효기간 재검증이 필요합니다.',409) from None
        registered_origin = b.get('deployment_origin', b.get('origin_url', '')).rstrip('/')
        if reported.rstrip('/') != u.geturl().rstrip('/') and not (native_valid and reported.rstrip('/') == registered_origin):
            raise HttpsError('현재 배포와 HTTPS 연결의 원본 주소가 다릅니다.', 409)
        return b['https_url']
