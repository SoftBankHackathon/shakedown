"""POST /api/deployments/{id}/stop: take finished targets down without changing the verdict."""
import json
import pytest
from fastapi.testclient import TestClient
from engine.api import create_app
from engine.deployments import DeploymentStore, DeployRequest
from test_comparisons import Runner, Shakedown, wait, project, request
from test_gcp_deployments import Gcp, URL

def deletes(*runners):
    return [(name, c[1]) for name, r in runners for c in r.calls if c[0] == 'DELETE']

def test_stop_deletes_every_target_keeps_verdict_and_is_idempotent(store, project, tmp_path):
    gcp, local = Gcp(), Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Shakedown(), poll_seconds=.001)
    with TestClient(create_app(store, ds)) as client:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'promoted' and 'stopped_at' not in d
        r = client.post(f"/api/deployments/{d['id']}/stop")
        assert r.status_code == 200
        stopped = r.json()
        assert stopped['status'] == 'promoted' and stopped['stopped_at'] >= d['finished']
        # Cloud first, then Local (reverse of deploy order), each by the ID the adapter knows.
        assert deletes(('gcp', gcp), ('local', local)) == [('gcp', '/deployments/' + d['id']), ('local', '/deployments/' + d['id'])]
        for name, url in (('local', 'https://test.trycloudflare.com'), ('gcp', URL)):
            t = stopped['targets'][name]
            assert (t['status'], t['instances'], t['url'], t['cleanup']) == ('stopped', 0, url, 'confirmed')
        again = client.post(f"/api/deployments/{d['id']}/stop")
        assert again.status_code == 200 and again.json() == stopped == ds.get(d['id'])
        assert len(deletes(('gcp', gcp), ('local', local))) == 2

def test_unknown_and_unfinished_deployments_are_refused(store, project, tmp_path):
    local = Runner(); ds = DeploymentStore(tmp_path/'d.db', local)
    d = {'id': 'dep_busy', 'project_id': project.id, 'status': 'deploying', 'options': {'local': {}}, 'targets': {'local': {'status': 'deploying'}}}
    with ds.connect() as db:
        db.execute('INSERT INTO deployments VALUES (?,?,?,?)', (d['id'], project.id, d['status'], json.dumps(d)))
    with TestClient(create_app(store, ds)) as client:
        assert client.post('/api/deployments/dep_missing/stop').status_code == 404
        r = client.post('/api/deployments/dep_busy/stop')
        assert r.status_code == 409 and 'deploying' in r.json()['detail']
        assert client.post('/api/deployments/dep_busy/stop', headers={'origin': 'https://evil.example'}).status_code == 403
    assert local.calls == [] and 'stopped_at' not in ds.get('dep_busy')

def test_blocked_deployment_stops_only_what_is_still_running_and_then_refuses_the_fix(store, project, tmp_path):
    gcp, local = Gcp(), Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Shakedown('BLOCKED'), poll_seconds=.001)
    with TestClient(create_app(store, ds)) as client:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'blocked' and d['targets']['gcp']['status'] == 'stopped'
        before = len(gcp.calls)
        stopped = client.post(f"/api/deployments/{d['id']}/stop").json()
        assert len(gcp.calls) == before and deletes(('local', local)) == [('local', '/deployments/' + d['id'])]
        assert stopped['status'] == 'blocked' and stopped['targets']['local']['status'] == 'stopped'
        r = client.post(f"/api/deployments/{d['id']}/fix")
        assert r.status_code == 400 and r.json()['detail'] == 'This deployment was stopped; start a new Action.'
        assert ds.get(d['id'])['status'] == 'blocked'

def test_failed_delete_is_reported_and_retried(store, project, tmp_path):
    gcp, local = Gcp(), Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Shakedown(), poll_seconds=.001)
    with TestClient(create_app(store, ds)) as client:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        gcp.fail = 'cleanup'
        r = client.post(f"/api/deployments/{d['id']}/stop")
        assert r.status_code == 200
        t = r.json()['targets']['gcp']
        assert t['cleanup'] == 'failed' and t['status'] == 'ready' and 'gcp' in t['error'] and 'PRIVATE_TOKEN' not in r.text
        assert r.json()['targets']['local']['status'] == 'stopped' and r.json()['status'] == 'promoted'
        gcp.fail = None
        retried = client.post(f"/api/deployments/{d['id']}/stop").json()
        assert retried['targets']['gcp']['status'] == 'stopped' and 'error' not in retried['targets']['gcp']
        assert deletes(('gcp', gcp), ('local', local)) == [('gcp', '/deployments/' + d['id'])] * 2 + [('local', '/deployments/' + d['id'])]
        assert retried['stopped_at'] == r.json()['stopped_at']

def test_comparison_and_never_submitted_targets_need_no_delete(store, project, tmp_path):
    local = Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, shakedown=Shakedown(), poll_seconds=.001)
    with TestClient(create_app(store, ds)) as client:
        c = wait(ds, ds.start_comparison(project, request())['id'])
        stopped = client.post(f"/api/deployments/{c['id']}/stop").json()
        assert stopped['stopped_at'] and stopped['status'] == 'promoted' and local.calls == []
        assert all(t['status'] == 'external' for t in stopped['targets'].values())
    gcp = Gcp('build'); ds2 = DeploymentStore(tmp_path/'d2.db', Runner(), gcp=gcp, poll_seconds=.001)
    try:
        d = wait(ds2, ds2.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'failed'
        stopped = ds2.stop(d['id'])
        assert not any(c[0] == 'DELETE' for c in gcp.calls) and stopped['stopped_at']
        assert all(t['status'] == 'stopped' for t in stopped['targets'].values())
    finally: ds2.close()

def test_target_the_adapter_never_accepted_is_not_deleted_again(store, project, tmp_path):
    # POST가 거절되면 run()의 정리 DELETE도 404로 cleanup='failed'가 남는다. 정리 버튼이 같은 404를 되풀이하면 안 된다.
    gcp, local = Gcp(), Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Shakedown(), poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        d['targets']['gcp'].pop('deployment_id'); d['targets']['gcp'].update(status='failed', cleanup='failed'); ds.save(d)
        stopped = ds.stop(d['id'])
        assert deletes(('gcp', gcp), ('local', local)) == [('local', '/deployments/' + d['id'])]
        assert stopped['targets']['gcp']['status'] == 'stopped'
    finally: ds.close()
