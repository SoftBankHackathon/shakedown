"""Cross-service boundary: never convert missing/contradictory evidence into PASS."""
import copy
import time
import pytest
from fastapi.testclient import TestClient
from engine.api import create_app
from engine.deployments import DeploymentStore, CompareRequest, DeployRequest, Endpoint, TERMINAL
from engine.models import CreateProjectRequest

class Runner:
    def __init__(self): self.calls = []
    def build(self, project, image): return project.analysis
    def call(self, method, path, body=None):
        self.calls.append((method,path,body))
        return {'status':'ready','url':'https://test.trycloudflare.com','instances':1}

class Shakedown:
    def __init__(self, result='PASS', broken=None): self.calls=[]; self.result=result; self.broken=broken
    def call(self, method, path, body=None):
        self.calls.append((method,path,body))
        if self.broken == 'transport': raise RuntimeError('PRIVATE_KEY')
        state = dict(shakedown_id='sd_test123', status='running', scenario={'steps':[{'index':1}]}, steps=[])
        if method == 'POST' or self.broken == 'timeout': return state
        state.update(status='done', steps=[dict(index=1, baseline='local', candidate='candidate', local={'status':'passed'}, cloud={'status':'passed'}, severity='ok')], verdict={'status':self.result}, report={'by':'rule'} if self.result=='BLOCKED' else None)
        if self.result == 'BLOCKED': state['steps'][0]['cloud']['status']='failed'; state['steps'][0]['severity']='critical'
        if self.broken == 'baseline': state['steps'][0]['local']['status']='failed'
        if self.broken == 'candidate': state['steps'][0]['cloud']['status']='failed'
        if self.broken == 'missing': state['steps']=[]
        if self.broken == 'failed': state['status']='failed'
        return copy.deepcopy(state)

def wait(ds,id):
    for _ in range(200):
        d=ds.get(id)
        if d['status'] in TERMINAL: return d
        time.sleep(.005)
    raise AssertionError('comparison did not terminate')

@pytest.fixture
def project(store, repository): return store.create(CreateProjectRequest(repo=str(repository),targets=['local']))

def request(): return CompareRequest(baseline=Endpoint(name='local',url='http://127.0.0.1:18080'),candidate=Endpoint(name='candidate',url='https://candidate.example'))

@pytest.mark.parametrize('result,status,gate',[('PASS','promoted','passed'),('WARN','warned','review'),('BLOCKED','blocked','blocked')])
def test_comparison_api_persists_evidence_without_deploying(store,project,tmp_path,result,status,gate):
    runner=Runner(); sd=Shakedown(result)
    ds=DeploymentStore(tmp_path/'d.db',runner,poll_seconds=.001,shakedown=sd)
    with TestClient(create_app(store,ds)) as client:
        r=client.post(f'/api/projects/{project.id}/comparisons',json=request().model_dump())
        assert r.status_code==202
        d=wait(ds,r.json()['id'])
        assert (d['status'],d['release_gate'],d['traffic_blocked'])==(status,gate,False)
        assert d['mode']=='comparison' and runner.calls==[]
        assert all(t['status']=='external' for t in d['targets'].values())
        assert d['attempts'][0]['verdict']['status']==result
        assert d['attempts'][0]['steps']
        assert '"kind": "done"' in client.get(f"/api/deployments/{d['id']}/events").text
    reopened=DeploymentStore(ds.path,runner)
    assert reopened.get(d['id'])==d
    reopened.close()

@pytest.mark.parametrize('broken',['transport','baseline','candidate','missing','failed','timeout'])
def test_bad_evidence_fails_closed_without_deleting_external_resources(project,tmp_path,broken):
    runner=Runner(); ds=DeploymentStore(tmp_path/'d.db',runner,poll_seconds=.001,shakedown=Shakedown(broken=broken),shakedown_timeout=.02 if broken=='timeout' else 1)
    try:
        d=wait(ds,ds.start_comparison(project,request())['id'])
        assert d['status']=='failed' and 'PRIVATE_KEY' not in str(d)
        assert 'verdict' not in d['attempts'][0] and runner.calls==[]
    finally: ds.close()

def test_local_deploy_then_compare(project,tmp_path):
    runner=Runner(); sd=Shakedown()
    ds=DeploymentStore(tmp_path/'d.db',runner,poll_seconds=.001,shakedown=sd)
    try:
        d=wait(ds,ds.start(project,DeployRequest(shakedown=True,comparison=request().candidate))['id'])
        assert d['status']=='promoted' and d['targets']['local']['status']=='ready'
        assert sd.calls[0][2]['baseline']['url']=='https://test.trycloudflare.com'
        assert [c[0] for c in runner.calls]==['POST','GET']
    finally: ds.close()

@pytest.mark.parametrize('url',['file:///etc/passwd','https://user:pass@example.com','https://example.com/path','https://example.com?token=secret'])
def test_invalid_endpoint_rejected(url):
    with pytest.raises(ValueError): Endpoint(name='candidate',url=url)

def test_same_environment_rejected(store,project,tmp_path):
    ds=DeploymentStore(tmp_path/'d.db',Runner(),shakedown=Shakedown())
    with TestClient(create_app(store,ds)) as client:
        body=request().model_dump(); body['candidate']['url']=body['baseline']['url']+'/'
        assert client.post(f'/api/projects/{project.id}/comparisons',json=body).status_code==400
