"""GET /api/services: short health probes to each target adapter and the shakedown service, never a deploy."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from fastapi.testclient import TestClient
from engine.api import create_app
from engine.deployments import DeploymentStore

class Health(BaseHTTPRequestHandler):
    # 경로마다 (상태 코드, 본문, 지연 초)를 정한다. 본문이 문자열이면 JSON이 아닌 응답이다.
    routes = {}
    def do_GET(self):
        status, body, delay = self.routes.get(self.path, (404, {}, 0))
        time.sleep(delay)
        raw = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *_): pass

@pytest.fixture
def server():
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), Health); httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{httpd.server_address[1]}'
    httpd.shutdown(); httpd.server_close()

class Fake:
    def __init__(self, base): self.base = base

def services(store, tmp_path, server, routes, shakedown='/sd'):
    Health.routes = routes
    ds = DeploymentStore(tmp_path/'d.db', Fake(server + '/local'), aws=Fake(server + '/aws'), gcp=Fake(server + '/gcp'),
                         azure=Fake(server + '/azure'), shakedown=Fake(server + shakedown))
    with TestClient(create_app(store, ds)) as client:
        started = time.monotonic()
        response = client.get('/api/services')
        return response, time.monotonic() - started

def test_reports_each_target_and_shakedown_ai(store, tmp_path, server):
    response, _ = services(store, tmp_path, server, {
        '/local/health': (200, {'ok': True, 'target': 'local'}, 0), '/aws/health': (503, {'ok': True}, 0),
        '/gcp/health': (200, {'ok': False}, 0), '/azure/health': (200, 'not json', 0),
        '/sd/health': (200, {'ok': True, 'ai': True, 'model': 'claude-x'}, 0)})
    assert response.status_code == 200
    assert response.json() == {'targets': {'local': {'online': True}, 'aws': {'online': False}, 'gcp': {'online': False}, 'azure': {'online': False}},
                               'shakedown': {'online': True, 'ai': True, 'model': 'claude-x'}}

@pytest.mark.parametrize('route, expected', [
    ((200, {'ok': True}, 0), {'online': True, 'ai': False, 'model': None}),
    ((200, {'ok': True, 'ai': 'yes', 'model': 3}, 0), {'online': True, 'ai': False, 'model': None}),
    ((500, {'ok': True, 'ai': True, 'model': 'claude-x'}, 0), {'online': False, 'ai': False, 'model': None}),
    (None, {'online': False, 'ai': False, 'model': None})])
def test_shakedown_without_ai_fields_or_unreachable(store, tmp_path, server, route, expected):
    response, _ = services(store, tmp_path, server, {'/sd/health': route} if route else {}, '/sd' if route else '/missing')
    assert response.json()['shakedown'] == expected

def test_slow_services_answer_together_within_budget(store, tmp_path, server):
    # 다섯 곳이 모두 3초씩 늦어도 동시에 물어보고 1초 남짓에 끊으므로 1.5초 안에 답한다.
    slow = (200, {'ok': True}, 3)
    response, elapsed = services(store, tmp_path, server, {f'/{n}/health': slow for n in ('local', 'aws', 'gcp', 'azure', 'sd')})
    assert response.status_code == 200 and elapsed < 1.6
    assert not any(t['online'] for t in response.json()['targets'].values()) and not response.json()['shakedown']['online']

def test_runner_without_base_is_offline_and_foreign_origin_refused(store, tmp_path):
    class NoBase: pass
    ds = DeploymentStore(tmp_path/'d.db', NoBase(), aws=NoBase(), gcp=NoBase(), azure=NoBase(), shakedown=NoBase())
    with TestClient(create_app(store, ds)) as client:
        assert client.get('/api/services', headers={'origin': 'https://evil.example'}).status_code == 403
        body = client.get('/api/services').json()
        assert body['targets'] == {n: {'online': False} for n in ('local', 'aws', 'gcp', 'azure')}
