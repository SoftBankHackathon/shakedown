"""Engine/GCP deployment tests: no GCP project, network, Docker or costs."""
import re
import time
import types
from pathlib import Path
import pytest
from engine import deployments
from engine.deployments import DeploymentStore, DeployRequest, DeploymentError
from test_comparisons import Runner, Shakedown, wait, project
from test_aws_deployments import Aws, DIGEST as AWS_DIGEST
from test_azure_deployments import Azure, PerCandidate, AZURE_IMAGE

DIGEST = 'asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/kty-board@sha256:' + 'b' * 64
AR = DIGEST.split('@')[0]
URL = 'https://shakedown-board-700410260240.asia-northeast3.run.app'

class Gcp:
    def __init__(self, fail=None): self.calls = []; self.fail = fail; self.builds = 0; self.preflights = 0; self.published = []
    def preflight(self, project):
        self.preflights += 1
        if self.fail == 'config': raise DeploymentError('GCP not configured')
    def build_publish(self, project, id):
        self.builds += 1
        if self.fail == 'build': raise RuntimeError('PRIVATE_TOKEN')
        return project.analysis, DIGEST
    def publish(self, source, id):
        # 실제 GcpRunner.publish처럼 출처의 digest를 그대로 Artifact Registry 주소에 붙여 돌려준다.
        self.published.append(source)
        if self.fail == 'publish': raise DeploymentError('Copying the image into Artifact Registry failed')
        return AR + '@' + source.split('@')[1]
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
def test_gcp_with_another_cloud_copies_the_first_clouds_digest(project, tmp_path, other):
    # TARGETS 순서상 GCP는 늘 마지막 클라우드라 빌드하지 않고, 첫 클라우드가 올린 digest를 복사(publish)한다.
    gcp, aws, azure, local = Gcp(), Aws(), Azure(), Runner(); sd = PerCandidate({other: 'PASS', 'gcp': 'PASS'})
    first, source = {'aws': (aws, AWS_DIGEST), 'azure': (azure, AZURE_IMAGE)}[other]
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, azure=azure, gcp=gcp, shakedown=sd, poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['gcp', other, 'local'], shakedown=True))['id'])
        assert d['status'] == 'promoted' and list(d['targets']) == ['local', other, 'gcp']
        assert (first.builds, gcp.builds, gcp.published, gcp.preflights) == (1, 0, [source], 1)
        assert local.calls[0][2]['image'] == first.calls[0][2]['image'] == source
        assert gcp.calls[0][2]['image'] == AR + '@' + source.split('@')[1]
        posts = [c[2] for c in sd.calls if c[0] == 'POST']
        assert [p['candidates'][0]['name'] for p in posts] == [other, 'gcp'] and all(p['baseline']['name'] == 'local' for p in posts)
        # 비교할 클라우드가 둘이면 수정 자동 적용 힌트를 주지 않는다(수정 적용은 Local + GCP 하나일 때만).
        assert not any('can_apply_env' in p['hints'] for p in posts)
    finally: ds.close()

@pytest.mark.parametrize('blocked, kept', [('aws', 'gcp'), ('gcp', 'aws')])
def test_only_the_blocked_cloud_is_closed_and_fix_stays_local_gcp_only(project, tmp_path, blocked, kept):
    gcp, aws, local = Gcp(), Aws(), Runner(); sd = PerCandidate({blocked: 'BLOCKED', kept: 'PASS'})
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, gcp=gcp, shakedown=sd, poll_seconds=.001)
    clouds = {'aws': aws, 'gcp': gcp}
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'aws', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'blocked' and d['traffic_blocked'] is True
        assert clouds[blocked].calls[-2][1].endswith('/logs') and clouds[blocked].calls[-1][0] == 'DELETE'
        assert not any(c[0] == 'DELETE' for c in clouds[kept].calls + local.calls)
        assert (d['targets'][blocked]['status'], d['targets'][kept]['status']) == ('stopped', 'ready')
        # 수정 적용은 Local + GCP 하나일 때만이다. 클라우드가 둘이면 GCP가 막혀도 거절하고 상태를 바꾸지 않는다.
        with pytest.raises(DeploymentError, match='Local \\+ GCP'): ds.apply_fix(project, d['id'])
        assert ds.get(d['id'])['status'] == 'blocked'
    finally: ds.close()

def test_failed_gcp_copy_fails_before_any_target_is_deployed(project, tmp_path):
    # 첫 클라우드 빌드·push는 끝났지만 아직 어떤 대상에도 POST하지 않았다. 지울 배포가 없으니 DELETE도 없다.
    gcp, aws, local = Gcp('publish'), Aws(), Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, gcp=gcp, shakedown=PerCandidate({}), poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'aws', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'failed' and d['error'] == 'Copying the image into Artifact Registry failed'
        assert (aws.builds, gcp.published) == (1, [AWS_DIGEST]) and aws.calls == gcp.calls == local.calls == []
    finally: ds.close()

def test_fix_refuses_two_clouds_even_if_more_clouds_become_fixable(project, tmp_path, monkeypatch):
    # 수정 재배포는 Local과 그 클라우드 하나만 다시 비교한다. 클라우드가 둘이면 다른 클라우드 결과가 덮이므로,
    # 나중에 AWS가 자동 수정 대상에 들어가도 Local + 클라우드 하나가 아니면 거절해야 한다.
    monkeypatch.setattr(deployments, 'ENV_FIX_TARGETS', {'aws', 'gcp'})
    gcp, aws = Gcp(), Aws(); sd = PerCandidate({'aws': 'BLOCKED', 'gcp': 'PASS'})
    ds = DeploymentStore(tmp_path/'d.db', Runner(), aws=aws, gcp=gcp, shakedown=sd, poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'aws', 'gcp'], shakedown=True))['id'])
        with pytest.raises(DeploymentError, match='Local \\+ GCP'): ds.apply_fix(project, d['id'])
    finally: ds.close()

def test_cloud_pair_without_local_never_offers_the_fix(project, tmp_path):
    # 수정 적용은 엔진이 띄운 Local이 기준일 때만 된다. AWS가 기준인 AWS+GCP에 힌트를 주면 고칠 수 없는 배포에 버튼이 뜬다.
    gcp, aws = Gcp(), Aws(); sd = PerCandidate({'gcp': 'BLOCKED'})
    ds = DeploymentStore(tmp_path/'d.db', Runner(), aws=aws, gcp=gcp, shakedown=sd, poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['aws', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'blocked' and gcp.published == [AWS_DIGEST]
        post = next(c[2] for c in sd.calls if c[0] == 'POST')
        assert post['baseline']['name'] == 'aws' and 'can_apply_env' not in post['hints']
    finally: ds.close()

def test_architecture_plan_goes_only_to_aws_when_gcp_comes_along(project, tmp_path):
    # GCP 어댑터는 모르는 필드를 400으로 거절한다(strict). 아키텍처 계획은 AWS 본문에만 실려야 한다.
    from engine.architecture import CATALOG
    class Planner:
        def resolve(self, p, id): return dict(next(t for t in CATALOG if t['id'] == 'medium'))
    gcp, aws, local = Gcp(), Aws(), Runner(); aws.validate_architecture = lambda spec, project=None: None
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, gcp=gcp, shakedown=PerCandidate({'aws': 'PASS', 'gcp': 'PASS'}), poll_seconds=.001)
    ds.architecture = Planner()
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'aws', 'gcp'], shakedown=True, architecture_plan_id='arch_' + 'a' * 32))['id'])
        assert d['status'] == 'promoted' and gcp.published == [AWS_DIGEST]
        aws_body, gcp_body = (next(c[2] for c in runner.calls if c[0] == 'POST') for runner in (aws, gcp))
        assert aws_body['architecture']['template_id'] == 'medium'
        assert 'architecture' not in gcp_body and 'env' not in gcp_body and gcp_body['options']['replicas'] == 2
    finally: ds.close()

def test_local_and_all_three_clouds_share_one_build(project, tmp_path):
    gcp, aws, azure, local = Gcp(), Aws(), Azure(), Runner(); sd = PerCandidate({'aws': 'PASS', 'azure': 'PASS', 'gcp': 'PASS'})
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, azure=azure, gcp=gcp, shakedown=sd, poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'aws', 'azure', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'promoted' and list(d['targets']) == ['local', 'aws', 'azure', 'gcp']
        assert (aws.builds, azure.builds, gcp.builds) == (1, 0, 0) and azure.published == gcp.published == [AWS_DIGEST]
        posts = [c[2] for c in sd.calls if c[0] == 'POST']
        assert [p['candidates'][0]['name'] for p in posts] == ['aws', 'azure', 'gcp']
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


@pytest.mark.parametrize('targets', [['gcp'], ['local', 'gcp']])
def test_selected_targets_use_digest_and_real_comparison(project, tmp_path, targets):
    gcp = Gcp(); aws = Aws(); local = Runner(); sd = Shakedown()
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, gcp=gcp, shakedown=sd, poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=targets, shakedown=len(targets)==2))['id'])
        assert d['status'] == ('promoted' if len(targets)==2 else 'deployed')
        assert list(d['targets']) == targets and d['image'] == DIGEST and gcp.builds == 1
        assert gcp.calls[0][2]['image'] == DIGEST and d['targets']['gcp']['url'] == URL
        assert aws.calls == [] and aws.builds == 0
        if len(targets)==2:
            assert local.calls[0][2]['image'] == DIGEST
            assert sd.calls[0][2]['baseline']['name'] == 'local'
            assert sd.calls[0][2]['candidates'][0] == {'name':'gcp', 'url':URL}
        else: assert local.calls == [] and sd.calls == []
    finally: ds.close()

@pytest.mark.parametrize('failure', ['post', 'url', 'build'])
def test_failures_do_not_leak_secrets_and_cleanup_both(project, tmp_path, failure):
    gcp = Gcp(failure); local = Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'failed' and 'PRIVATE_TOKEN' not in str(d)
        assert any(c[0]=='DELETE' for c in gcp.calls) == (failure != 'build')
        assert any(c[0]=='DELETE' for c in local.calls) == (failure != 'build')
    finally: ds.close()

@pytest.mark.parametrize('cleanup_failure', [False, True])
def test_blocked_stops_only_managed_gcp_after_logs(project, tmp_path, cleanup_failure):
    gcp = Gcp('cleanup' if cleanup_failure else None); local = Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Shakedown('BLOCKED'), poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'blocked' and d['traffic_blocked'] is (not cleanup_failure)
        assert gcp.calls[-2][1].endswith('/logs') and gcp.calls[-1][0] == 'DELETE'
        assert d['targets']['gcp']['status'] == ('failed' if cleanup_failure else 'stopped')
        assert not any(c[0]=='DELETE' for c in local.calls) and 'PRIVATE_TOKEN' not in str(d)
    finally: ds.close()

def test_gcp_timeout_attempts_delete(project, tmp_path):
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, ready_timeouts={'gcp': 0})
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['gcp']))['id'])
        assert d['status'] == 'failed' and 'timed out' in d['error']
        assert gcp.calls[-1][0] == 'DELETE' and d['targets']['gcp']['status'] == 'stopped'
    finally: ds.close()


RUNTIME = {'version': 'http-runtime.v1', 'port': 3000, 'health_path': '/healthz', 'env': {'NODE_ENV': 'production'}, 'secret_refs': {'APP_DB_PASSWORD': 'db_password'},
           'database': {'mode': 'postgres', 'name': 'board_db', 'bindings': {'DB_URL': 'jdbc_url', 'DB_PASSWORD': 'password'}}, 'init_command': []}

def test_runtime_project_sends_its_runtime_to_gcp_without_legacy_fields_or_the_env_fix_hint(project, tmp_path):
    gcp = Gcp(); sd = Shakedown()
    saved = project.model_copy(update={'runtime': RUNTIME})
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=sd, poll_seconds=.001)
    try:
        assert wait(ds, ds.start(saved, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])['status'] == 'promoted'
        body = next(body for method, _, body in gcp.calls if method == 'POST')
        assert body['runtime'] == RUNTIME and (body['port'], body['health_path']) == (3000, '/healthz')
        assert 'database' not in body and 'secret_refs' not in body and 'env' not in body
        # env 수정안(SPRING_PROFILES_ACTIVE=demo,session-jdbc)은 Spring 샘플 전용이라 runtime 프로젝트에는 자동 적용 힌트를 주지 않는다.
        assert [('can_apply_env' in body['hints']) for method, _, body in sd.calls if method == 'POST'] == [False]
    finally: ds.close()

@pytest.mark.parametrize('target, architecture, overrides, limit', [
    ('gcp', None, None, 450), ('local', None, None, 300), ('aws', None, None, 300), ('azure', None, None, 300),
    ('aws', {'id': 'aws-ha'}, None, 2700),
    # 다른 대상만 바꿔 넘겨도 GCP 예외는 남아야 한다.
    ('local', None, {'local': 120}, 120), ('gcp', None, {'local': 120}, 450)])
def test_ready_wait_gives_only_gcp_extra_time(tmp_path, monkeypatch, target, architecture, overrides, limit):
    # GCP 어댑터는 420초를 넘기면 0대로 내린 뒤(최대 19초) failed를 낸다. 엔진이 먼저 끊으면 늘린 어댑터 한도가 소용없다.
    # 실제로 7분 30초를 기다리지 않도록 이 모듈의 시계와 sleep만 가짜로 바꾼다.
    clock = [0.0]
    monkeypatch.setattr(deployments, 'time', types.SimpleNamespace(
        monotonic=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s), time=time.time))
    class Pending:
        def call(self, method, path, body=None): return {'status': 'deploying'}
    pending = Pending(); ds = DeploymentStore(tmp_path/'d.db', pending, aws=pending, azure=pending, gcp=pending, ready_timeouts=overrides)
    try:
        with pytest.raises(DeploymentError, match=f'{target} deployment readiness timed out'):
            ds.wait_ready({'id': 'dep_x', 'project_id': 'prj_x', 'architecture': architecture, 'targets': {target: {}}}, target)
        assert clock[0] == limit
    finally: ds.close()

def test_gcp_wait_outlasts_adapter_limit_and_stop(tmp_path):
    # 어댑터 한도와 stop 예산은 infra/gcp/src/gcp-provider.ts에 있다. 둘에 여유를 더한 것보다 엔진이 길게 기다려야
    # 엔진이 시간 초과로 끊기 전에 어댑터의 failed가 닿는다. 한쪽만 바꾸면 여기서 깨진다.
    # 여유 10초: 엔진 폴링 간격(1초), abort가 진행 중 GCP 호출에 닿는 지연, failed 기록까지의 시간.
    source = (Path(__file__).resolve().parents[3] / 'infra/gcp/src/gcp-provider.ts').read_text()
    adapter_ms = {}
    for name in ('READY_TIMEOUT_MS', 'STOP_TIMEOUT_MS'):
        found = re.search(rf'export const {name} = ([\d_]+);', source)
        assert found, f'{name} must stay a numeric literal in gcp-provider.ts so this check can read it'
        adapter_ms[name] = int(found.group(1).replace('_', ''))
    ds = DeploymentStore(tmp_path/'d.db', Runner())
    try: assert adapter_ms['READY_TIMEOUT_MS'] + adapter_ms['STOP_TIMEOUT_MS'] + 10_000 <= ds.ready_timeouts['gcp'] * 1000
    finally: ds.close()
