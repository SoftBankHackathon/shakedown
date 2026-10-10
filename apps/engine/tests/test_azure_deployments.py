"""Engine orchestration with Azure as a third target: no Azure account, network, Docker or costs."""
import copy
import pytest
from engine.deployments import DeploymentStore, DeployRequest, DeploymentError
from test_aws_deployments import Aws, DIGEST, URL as AWS_URL
from test_comparisons import Runner, wait, project

AZURE_IMAGE = 'sdacrtest.azurecr.io/board@sha256:' + 'a' * 64
AZURE_URL = 'https://sd-app.test.koreacentral.azurecontainerapps.io'

class Azure(Aws):
    def __init__(self, fail=None): super().__init__(fail); self.published = []
    def build_publish(self, project, id):
        self.builds += 1
        return project.analysis, AZURE_IMAGE
    def publish(self, source, id):
        self.published.append(source)
        return AZURE_IMAGE
    def valid_url(self, url): return url == AZURE_URL
    def call(self, method, path, body=None):
        state = super().call(method, path, body)
        return {**state, 'url': AZURE_URL} if isinstance(state, dict) and 'url' in state else state

class PerCandidate:
    """Shakedown fake whose verdict depends on the candidate of the current run."""
    def __init__(self, results): self.calls = []; self.results = results; self.current = None
    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == 'POST': self.current = body['candidates'][0]['name']
        state = dict(shakedown_id='sd_' + self.current, status='running', scenario={'steps': [{'index': 1}]}, steps=[])
        if method == 'POST': return state
        result = self.results[self.current]
        cloud = 'failed' if result == 'BLOCKED' else 'passed'
        state.update(status='done', verdict={'status': result}, report={'by': 'rule'} if result == 'BLOCKED' else None,
                     steps=[dict(index=1, baseline='local', candidate=self.current, local={'status': 'passed'},
                                 cloud={'status': cloud}, severity='critical' if result == 'BLOCKED' else 'ok')])
        return copy.deepcopy(state)

def store(tmp_path, results=None, **kw):
    aws, azure, local = Aws(), Azure(), Runner()
    sd = PerCandidate(results or {'aws': 'PASS', 'azure': 'PASS'})
    return DeploymentStore(tmp_path/'d.db', local, aws=aws, azure=azure, shakedown=sd, poll_seconds=.001, **kw), aws, azure, local, sd

def test_three_targets_share_one_digest_and_run_one_shakedown_per_cloud(project, tmp_path):
    ds, aws, azure, local, sd = store(tmp_path)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['azure', 'local', 'aws'], shakedown=True))['id'])
        assert d['status'] == 'promoted' and list(d['targets']) == ['local', 'aws', 'azure']
        assert aws.builds == 1 and azure.builds == 0 and azure.published == [DIGEST]
        assert aws.calls[0][2]['image'] == DIGEST and azure.calls[0][2]['image'] == AZURE_IMAGE
        assert DIGEST.split('@')[1] == AZURE_IMAGE.split('@')[1]
        posts = [c[2] for c in sd.calls if c[0] == 'POST']
        assert [p['candidates'][0]['name'] for p in posts] == ['aws', 'azure'] and all(p['baseline']['name'] == 'local' for p in posts)
        assert [s['candidate'] for s in d['attempts'][0]['steps']] == ['aws', 'azure']
    finally: ds.close()

def test_only_the_blocked_cloud_is_closed(project, tmp_path):
    ds, aws, azure, local, _ = store(tmp_path, {'aws': 'BLOCKED', 'azure': 'PASS'})
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'aws', 'azure'], shakedown=True))['id'])
        assert d['status'] == 'blocked' and d['traffic_blocked'] is True
        assert aws.calls[-1][0] == 'DELETE' and not any(c[0] == 'DELETE' for c in azure.calls + local.calls)
        assert d['targets']['azure']['status'] == 'ready' and d['targets']['aws']['status'] == 'stopped'
        assert d['attempts'][0]['verdict']['status'] == 'BLOCKED'
    finally: ds.close()

def test_azure_alone_builds_into_acr(project, tmp_path):
    ds, aws, azure, local, sd = store(tmp_path)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['azure']))['id'])
        assert d['status'] == 'deployed' and azure.builds == 1 and aws.builds == 0 and d['image'] == AZURE_IMAGE
        assert d['targets']['azure']['label'] == 'Azure Container Apps' and sd.calls == []
    finally: ds.close()

def test_sticky_sessions_are_azure_only(project, tmp_path):
    ds, *_ = store(tmp_path)
    try:
        d = ds.start(project, DeployRequest(targets=['azure'], options={'azure': {'sticky_sessions': True}}))
        assert d['options']['azure'] == {'replicas': 2, 'sticky_sessions': True, 'tz': 'UTC'}
        wait(ds, d['id'])
    finally: ds.close()

@pytest.mark.parametrize('body', [
    dict(targets=['aws'], options={'aws': {'sticky_sessions': True}}),
    dict(targets=['azure'], options={'azure': {'replicas': 3}}),
    dict(targets=['azure'], options={'azure': {'sticky_sessions': 'yes'}}),
    dict(targets=['azure', 'azure']),
    dict(targets=['local', 'azure']),  # two targets require a shakedown
])
def test_invalid_azure_selection_rejected_before_build(project, tmp_path, body):
    ds, aws, azure, *_ = store(tmp_path)
    try:
        with pytest.raises(DeploymentError): ds.start(project, DeployRequest(**body))
        assert not azure.calls and not azure.builds and not aws.builds
    finally: ds.close()
