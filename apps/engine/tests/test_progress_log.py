"""Deployment progress log (d['log']) and its SSE replay: short engine lines, never env values or raw application logs."""
import copy
import json
import pytest
from fastapi.testclient import TestClient
from engine.api import create_app
from engine.deployments import DeploymentStore, DeployRequest, LOG_LIMIT
from test_comparisons import Runner, Shakedown, wait, project
from test_gcp_deployments import Gcp, URL, RUNTIME

class Titled(Shakedown):
    """Two-step scenario whose rows arrive one poll at a time, like the real runner."""
    def __init__(self, result='PASS', kind=None): super().__init__(result); self.polls = 0; self.kind = kind
    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        scenario = {'steps': [{'title': 'Open home'}, {'title': 'Publish a post'}]}
        row = lambda i, title, kind: dict(index=i, title=title, local={'status': 'passed'}, cloud={'status': 'passed' if kind == 'same' else 'failed'},
                                          kind=kind, severity='none' if kind == 'same' else 'critical')
        state = dict(shakedown_id='sd_titled', status='running', scenario=scenario, steps=[])
        if method == 'POST': return state
        self.polls += 1
        state['steps'] = [row(1, 'Open home', 'same')]
        if self.polls >= 2:
            state['steps'].append(row(2, 'Publish a post', self.kind or ('same' if self.result == 'PASS' else 'env_diff')))
            state.update(status='done', verdict={'status': self.result}, report={'by': 'rule'} if self.result == 'BLOCKED' else None)
        return copy.deepcopy(state)

def lines(d, source=None):
    return [e['line'] for e in d['log'] if source is None or e['source'] == source]

def test_deploy_logs_build_targets_steps_and_verdict_in_order(project, tmp_path):
    gcp, local = Gcp(), Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Titled(), poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'promoted'
        assert all(set(e) == {'ts', 'source', 'line'} for e in d['log'])
        assert [e['ts'] for e in d['log']] == sorted({e['ts'] for e in d['log']})
        assert {e['source'] for e in d['log']} == {'engine', 'local', 'gcp'}
        engine = lines(d, 'engine')
        assert engine[0].startswith('Build started') and any(l.startswith('Build finished in ') and l.endswith('s') for l in engine)
        assert lines(d, 'gcp')[0] == 'Image pushed to the gcp registry'
        assert 'Deploy submitted' in lines(d, 'local') and f'Ready at {URL} (2 instances)' in lines(d, 'gcp')
        assert 'Shakedown started: local vs gcp' in engine
        assert engine.count('gcp step 1/2 Open home: same') == 1 and 'gcp step 2/2 Publish a post: same' in engine
        assert engine[-1] == 'Verdict: PASS'
    finally: ds.close()

def test_both_failed_step_is_not_logged_as_a_difference(project, tmp_path):
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=Gcp(), shakedown=Titled('PASS', 'both_failed'), poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert 'gcp step 2/2 Publish a post: both failed' in lines(d, 'engine')
    finally: ds.close()

def test_blocked_logs_report_and_cleanup_and_failures_stay_sanitized(project, tmp_path):
    gcp, local = Gcp(), Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Titled('BLOCKED'), poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert 'gcp step 2/2 Publish a post: differs' in lines(d) and 'Verdict: BLOCKED' in lines(d)
        assert 'Cause report received' in lines(d) and 'Stopped (cleanup confirmed)' in lines(d, 'gcp')
        d = ds.stop(d['id'])
        assert lines(d)[-2:] == ['Stopped', 'Stop finished'] and lines(d, 'local')[-1] == 'Stopped'
    finally: ds.close()
    gcp = Gcp('build'); ds = DeploymentStore(tmp_path/'f.db', Runner(), gcp=gcp, poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'failed' and lines(d)[-1] == 'Failed: ' + d['error'] and 'PRIVATE_TOKEN' not in json.dumps(d['log'])
    finally: ds.close()

def test_readiness_timeout_is_logged(project, tmp_path):
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, ready_timeouts={'gcp': 0})
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['gcp']))['id'])
        assert 'Readiness timed out after 0s' in lines(d, 'gcp')
    finally: ds.close()

def test_env_and_runtime_values_never_reach_the_log(project, tmp_path):
    gcp = Gcp(); saved = project.model_copy(update={'runtime': RUNTIME})
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Shakedown(), poll_seconds=.001)
    try:
        d = wait(ds, ds.start(saved, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        text = json.dumps(d['log'])
        assert d['log'] and 'production' not in text and 'db_password' not in text and 'session-jdbc' not in text
    finally: ds.close()

def test_log_is_capped(tmp_path):
    ds = DeploymentStore(tmp_path/'d.db', Runner())
    try:
        d = {}
        for i in range(LOG_LIMIT + 50): ds.log(d, f'line {i}')
        assert len(d['log']) == LOG_LIMIT == 300 and d['log'][-1]['line'] == f'line {LOG_LIMIT + 49}'
    finally: ds.close()

def test_sse_replays_every_log_line_once_then_stage_and_done(store, project, tmp_path):
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Titled(), poll_seconds=.001)
    with TestClient(create_app(store, ds)) as client:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        events = [json.loads(chunk[6:]) for chunk in client.get(f"/api/deployments/{d['id']}/events").text.split('\n\n') if chunk.startswith('data: ')]
        logs = [e for e in events if e['kind'] == 'log']
        assert [{k: e[k] for k in ('ts', 'source', 'line')} for e in logs] == d['log']
        # The old status-only log line is gone; status changes stay in 'stage' events.
        assert not any(e['line'] == 'promoted' for e in logs)
        assert [e['kind'] for e in events[len(logs):]] == ['stage', 'done'] and events[-1]['status'] == 'promoted'
