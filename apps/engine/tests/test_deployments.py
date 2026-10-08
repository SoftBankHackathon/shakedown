import threading
import time
import pytest
from fastapi.testclient import TestClient
from engine.api import create_app
from engine.deployments import DeploymentStore, DeploymentError, DeployRequest, Busy
from engine.models import CreateProjectRequest

class Runner:
    def __init__(self, failure=None, gate=None):
        self.failure, self.gate, self.calls = failure, gate, []
    def build(self, project, image):
        if self.gate: self.gate.wait(3)
        if self.failure == 'build': raise RuntimeError('PRIVATE_PASSWORD')
        return project.analysis
    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == 'POST': return {'status':'pending'}
        if method == 'DELETE': return None
        return {'status':'failed' if self.failure else 'ready', 'url':'https://test.trycloudflare.com', 'instances':1}

@pytest.fixture
def project(store, repository):
    return store.create(CreateProjectRequest(repo=str(repository), targets=['local']))

def finish(store, id):
    for _ in range(100):
        d = store.get(id)
        if d['status'] in {'deployed','failed'}: return d
        time.sleep(.01)
    raise AssertionError('worker did not finish')

def test_api_deploy_persistence_and_sse(store, project, tmp_path):
    runner = Runner(); ds = DeploymentStore(tmp_path/'deployments.db', runner)
    with TestClient(create_app(store, ds)) as client:
        r = client.post(f'/api/projects/{project.id}/deployments', json={})
        assert r.status_code == 202
        d = finish(ds, r.json()['id'])
        assert d['status'] == 'deployed' and d['attempts'] == [] and not d['shakedown']
        assert d['targets']['local']['url'].startswith('https://')
        assert runner.calls[0][2]['database']['engine'] == 'postgres'
        assert 'SPRING_DATASOURCE_PASSWORD' not in runner.calls[0][2].get('env', {})
        assert client.get('/api/deployments/'+d['id']).json() == d
        assert len(client.get('/api/deployments', params={'project_id':project.id}).json()) == 1
        events = client.get('/api/deployments/'+d['id']+'/events').text
        assert '"kind": "done"' in events and 'deployed' in events
    reopened = DeploymentStore(ds.path, runner)
    assert reopened.get(d['id']) == d
    reopened.close()

@pytest.mark.parametrize('failure', ['build', 'target'])
def test_failure_no_verdict_and_cleanup(project, tmp_path, failure):
    runner = Runner(failure); ds = DeploymentStore(tmp_path/'d.db', runner)
    try:
        d = finish(ds, ds.start(project, DeployRequest())['id'])
        assert d['status'] == 'failed' and d['attempts'] == []
        assert 'PRIVATE_PASSWORD' not in str(d)
        assert any(c[0]=='DELETE' for c in runner.calls) == (failure == 'target')
    finally: ds.close()

def test_concurrent_project_conflict_and_unavailable_features(project, tmp_path):
    gate = threading.Event(); ds = DeploymentStore(tmp_path/'d.db', Runner(gate=gate))
    try:
        with pytest.raises(DeploymentError): ds.start(project, DeployRequest(shakedown=True))
        with pytest.raises(DeploymentError): ds.start(project, DeployRequest(options={'aws':{}}))
        ds.start(project, DeployRequest())
        with pytest.raises(Busy): ds.start(project, DeployRequest())
    finally: gate.set(); ds.close()

def test_recovery_marks_interrupted_work_failed(tmp_path):
    import json
    ds = DeploymentStore(tmp_path/'d.db', Runner())
    d = {'id':'dep_old','project_id':'p','status':'building'}
    with ds.connect() as db:
        db.execute('INSERT INTO deployments VALUES (?,?,?,?)', ('dep_old','p','building',json.dumps(d)))
    ds.close()
    ds = DeploymentStore(tmp_path/'d.db', Runner())
    assert ds.get('dep_old')['status'] == 'failed'
    ds.close()

def test_foreign_origin_cannot_build(client):
    assert client.post('/api/projects/x/deployments', json={}, headers={'origin':'https://evil.example'}).status_code == 403

def test_timeout_cleans_up_without_shakedown(project, tmp_path):
    runner = Runner()
    ds = DeploymentStore(tmp_path/'d.db', runner, timeout=0)
    try:
        d = finish(ds, ds.start(project, DeployRequest())['id'])
        assert d['status'] == 'failed' and 'timed out' in d['error']
        assert runner.calls[-1][0] == 'DELETE'
        assert not d['attempts']
    finally: ds.close()
