"""Engine/GCP deployment tests: no GCP project, network, Docker or costs."""
import pytest
from engine.deployments import DeploymentStore, DeployRequest, DeploymentError
from test_comparisons import Runner, Shakedown, wait, project
from test_aws_deployments import Aws

DIGEST = 'asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/kty-board@sha256:' + 'b' * 64
URL = 'https://shakedown-board-700410260240.asia-northeast3.run.app'

class Gcp:
    def __init__(self, fail=None): self.calls = []; self.fail = fail; self.builds = 0; self.preflights = 0
    def preflight(self, project):
        self.preflights += 1
        if self.fail == 'config': raise DeploymentError('GCP not configured')
    def build_publish(self, project, id):
        self.builds += 1
        if self.fail == 'build': raise RuntimeError('PRIVATE_TOKEN')
        return project.analysis, DIGEST
    def valid_url(self, url): return url == URL
    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == 'DELETE' and self.fail == 'cleanup': raise RuntimeError('PRIVATE_TOKEN')
        if method == 'POST' and self.fail == 'post': raise DeploymentError('GCP transport failed')
        if method == 'DELETE': return None
        if path.endswith('/logs'): return []
        return {'status': 'ready', 'url': 'https://evil.run.app' if self.fail == 'url' else URL, 'instances': 2, 'info': {'runtime': 'Cloud Run'}}

@pytest.mark.parametrize('body', [dict(targets=['local', 'gcp']), dict(targets=['gcp'], options={'gcp': {'replicas': 3}}),
    dict(targets=['gcp'], options={'gcp': {'replicas': True}}), dict(targets=['gcp'], options={'gcp': {'sticky_sessions': 'yes'}}),
    dict(targets=['gcp'], options={'gcp': {'tz': 'Mars/Base'}}), dict(targets=['gcp'], options={'gcp': {'cpu': 2}}),
    dict(targets=['local', 'gcp'], shakedown=True, options={'local': {'sticky_sessions': True}})])
def test_invalid_selection_rejected_before_build(project, tmp_path, body):
    gcp = Gcp(); aws = Aws(); ds = DeploymentStore(tmp_path/'d.db', Runner(), aws=aws, gcp=gcp)
    try:
        with pytest.raises(DeploymentError): ds.start(project, DeployRequest(**body))
        assert not gcp.calls and not gcp.builds and not aws.calls and not aws.builds and ds.list() == []
    finally: ds.close()

@pytest.mark.parametrize('other', ['aws', 'azure'])
def test_gcp_with_another_cloud_is_rejected_before_any_cloud_call(project, tmp_path, other):
    # GCP는 다른 클라우드 저장소로 이미지를 복사하지 않으므로 다른 클라우드와 함께 받지 않는다.
    gcp = Gcp(); aws = Aws(); azure = Aws(); ds = DeploymentStore(tmp_path/'d.db', Runner(), aws=aws, azure=azure, gcp=gcp)
    try:
        with pytest.raises(DeploymentError, match='GCP cannot be combined'): ds.start(project, DeployRequest(targets=[other, 'gcp'], shakedown=True))
        assert (gcp.preflights, gcp.builds, aws.builds, aws.calls, azure.builds, azure.calls, ds.list()) == (0, 0, 0, [], 0, [], [])
    finally: ds.close()

def test_gcp_allows_sticky_sessions_and_keeps_cloud_defaults(project, tmp_path):
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Shakedown(), poll_seconds=.001)
    try:
        d = ds.start(project, DeployRequest(targets=['gcp', 'local'], shakedown=True, options={'gcp': {'sticky_sessions': True}}))
        assert list(d['targets']) == ['local', 'gcp'] and gcp.preflights == 1
        assert d['targets']['gcp'] == {'status': 'pending', 'label': 'GCP Cloud Run'}
        assert d['options'] == {'local': {'replicas': 1, 'sticky_sessions': False, 'tz': 'Asia/Seoul'},
                                'gcp': {'replicas': 2, 'sticky_sessions': True, 'tz': 'UTC'}}
    finally: ds.close()

def test_missing_config_api_returns_actionable_error_without_job(store, project, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from engine.api import create_app
    monkeypatch.delenv('GCP_ADAPTER_CONFIG', raising=False)
    ds = DeploymentStore(tmp_path/'d.db', Runner())
    with TestClient(create_app(store, ds)) as client:
        response = client.post(f'/api/projects/{project.id}/deployments', json={'targets': ['local', 'gcp'], 'shakedown': True})
        assert response.status_code == 400 and 'GCP_ADAPTER_CONFIG' in response.json()['detail']
        assert ds.list() == []
