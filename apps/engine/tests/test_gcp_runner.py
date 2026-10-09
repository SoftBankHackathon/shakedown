"""Engine/GCP runner boundary tests: no GCP project, network, Docker or costs."""
import json
from pathlib import Path
import httpx
import pytest
from engine import gcp_runner
from engine.deployments import DeploymentError
from engine.gcp_runner import GcpRunner
from test_comparisons import project

PREFIX = 'asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/'
DIGEST = PREFIX + 'kty-board@sha256:' + 'a' * 64
URL = 'https://shakedown-board-700410260240.asia-northeast3.run.app'

@pytest.fixture
def configured(monkeypatch, tmp_path, project):
    # Same keys as infra/gcp/.data/config.json written by provision.sh.
    config = {'gcpProject': 'shakedown-511106', 'gcpProjectNumber': '700410260240', 'region': 'asia-northeast3',
              'projectId': project.id, 'serviceName': 'shakedown-board', 'jobName': 'shakedown-board-schema',
              'imagePrefixes': [PREFIX], 'network': 'default', 'subnetwork': 'default', 'dbHost': '10.20.0.3',
              'dbName': project.analysis.database_name or 'board_db', 'dbUsername': 'board',
              'dbPasswordSecret': 'shakedown-db-password', 'port': project.analysis.port, 'memory': '1Gi', 'cpu': '1'}
    path = tmp_path / 'gcp.json'; path.write_text(json.dumps(config))
    monkeypatch.setenv('GCP_ADAPTER_CONFIG', str(path))
    return config, path

def test_missing_gcp_configuration_is_clear(monkeypatch):
    monkeypatch.delenv('GCP_ADAPTER_CONFIG', raising=False)
    with pytest.raises(DeploymentError, match='GCP_ADAPTER_CONFIG'): GcpRunner().config()

@pytest.mark.parametrize('patch', [{'region': 'us-central1'}, {'gcpProject': 'Bad_Project'}, {'gcpProjectNumber': 'abc'},
                                   {'serviceName': 'Bad_Name'}, {'imagePrefixes': []}, {'imagePrefixes': ['docker.io/library/']},
                                   {'imagePrefixes': ['asia-northeast3-docker.pkg.dev/other-project/shakedown/']}])
def test_config_rejects_mismatched_resources(configured, patch):
    config, path = configured; config.update(patch); path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError, match='Invalid GCP'): GcpRunner().config()

@pytest.mark.parametrize('key', ['projectId', 'port', 'dbName'])
def test_config_requires_engine_binding_keys(configured, key):
    config, path = configured; del config[key]; path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError, match='Invalid GCP'): GcpRunner().config()

def test_valid_url_is_only_the_configured_service(configured):
    runner = GcpRunner()
    assert runner.valid_url(URL) and runner.valid_url(URL + '/')
    assert not runner.valid_url('https://evil.run.app') and not runner.valid_url(URL.replace('https', 'http'))

def test_call_uses_fixed_loopback_and_hides_errors(monkeypatch):
    seen, real = [], httpx.Client
    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(500 if request.method == 'DELETE' else 200, json={'ok': True, 'target': 'gcp'})
    monkeypatch.setattr(gcp_runner.httpx, 'Client', lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    assert GcpRunner().call('GET', '/health') == {'ok': True, 'target': 'gcp'}
    with pytest.raises(DeploymentError, match='GCP Target request failed'): GcpRunner().call('DELETE', '/deployments/dep_a')
    assert seen == ['http://127.0.0.1:9103/health', 'http://127.0.0.1:9103/deployments/dep_a']


def test_project_mismatch_before_any_gcp_call(monkeypatch, configured, project):
    config, path = configured; config['projectId'] = 'prj_other'; path.write_text(json.dumps(config))
    runner, calls = GcpRunner(), []
    monkeypatch.setattr(runner, 'capture', lambda *a, **k: calls.append(a))
    monkeypatch.setattr(runner, 'call', lambda *a, **k: calls.append(a))
    with pytest.raises(DeploymentError, match='projectId') as error: runner.preflight(project)
    # 어댑터 상태 DB는 projectId에 묶여 있어, 같은 DB로 다시 띄우면 기동을 거부한다. 새 DB 파일을 쓰라고 알려야 한다.
    assert 'GCP_ADAPTER_DB' in str(error.value)
    assert calls == []

def test_port_or_database_mismatch_is_rejected(configured, project):
    config, path = configured; config['dbName'] = 'other_db'; path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError, match='port/database'): GcpRunner().preflight(project)

def test_saved_runtime_is_rejected_before_any_gcp_call(monkeypatch, configured, project):
    # 실행 설정(runtime)을 저장한 프로젝트는 database·secret_refs 대신 runtime을 보낸다. GCP 어댑터는 PostgreSQL 샘플 계약만 받는다.
    runner, calls = GcpRunner(), []
    monkeypatch.setattr(runner, 'capture', lambda *a, **k: calls.append(a))
    monkeypatch.setattr(runner, 'call', lambda *a, **k: calls.append(a))
    saved = project.model_copy(update={'runtime': {'port': 8080, 'health_path': '/health', 'database': {'mode': 'none'}}})
    with pytest.raises(DeploymentError, match='runtime'): runner.preflight(saved)
    assert calls == []

def test_gcloud_project_mismatch_fails_before_adapter(monkeypatch, configured, project):
    runner, calls = GcpRunner(), []
    monkeypatch.setattr(runner, 'capture', lambda args, **k: calls.append(args) or 'other-project')
    monkeypatch.setattr(runner, 'call', lambda *a, **k: pytest.fail('adapter must not be called'))
    with pytest.raises(DeploymentError, match='gcloud'): runner.preflight(project)
    assert calls == [['gcloud', 'config', 'get', 'project']]

def test_missing_gcloud_on_the_engine_is_named_in_preflight(monkeypatch, configured, project):
    # 엔진을 gcloud가 PATH에 없는 셸에서 띄우면 빌드 전 사전 확인에서 멈춘다. 오류가 "push 실패"가 아니라 엔진의 gcloud를 가리켜야 한다.
    runner = GcpRunner()
    def missing(args, **kwargs): raise DeploymentError('GCP publishing command failed; check gcloud login, Artifact Registry permissions and Docker. No credentials were logged.')
    monkeypatch.setattr(runner, 'capture', missing)
    monkeypatch.setattr(runner, 'call', lambda *a, **k: pytest.fail('adapter must not be called'))
    with pytest.raises(DeploymentError, match='gcloud CLI is not available to the engine'): runner.preflight(project)

@pytest.mark.parametrize('health', [None, {'ok': True, 'target': 'aws'}, {'ok': False, 'target': 'gcp'}])
def test_adapter_must_be_the_gcp_target(monkeypatch, configured, project, health):
    runner = GcpRunner()
    monkeypatch.setattr(runner, 'capture', lambda args, **k: 'shakedown-511106')
    monkeypatch.setattr(runner, 'call', lambda method, path, body=None: health)
    with pytest.raises(DeploymentError, match='9103'): runner.preflight(project)

def test_preflight_passes_when_project_gcloud_and_adapter_match(monkeypatch, configured, project):
    runner = GcpRunner()
    monkeypatch.setattr(runner, 'capture', lambda args, **k: 'shakedown-511106')
    monkeypatch.setattr(runner, 'call', lambda method, path, body=None: {'ok': True, 'target': 'gcp'})
    assert runner.preflight(project) is None

def test_failed_command_hides_its_output(monkeypatch):
    def fail(args, **kwargs): raise gcp_runner.subprocess.CalledProcessError(1, args, output=b'TOKEN_DO_NOT_LOG')
    monkeypatch.setattr(gcp_runner.subprocess, 'run', fail)
    with pytest.raises(DeploymentError) as error: GcpRunner.capture(['gcloud', 'auth', 'print-access-token'])
    assert 'TOKEN_DO_NOT_LOG' not in str(error.value) and 'No credentials were logged' in str(error.value)
