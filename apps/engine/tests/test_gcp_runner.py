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
