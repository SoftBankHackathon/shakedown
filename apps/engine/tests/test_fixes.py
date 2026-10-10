"""차단 뒤 수정 적용 흐름 테스트: 실제 GCP·AWS·Docker·네트워크 없이 가짜 어댑터와 가짜 시운전만 쓴다."""
import re
import threading
import time
import pytest
from engine.deployments import DeploymentStore, DeployRequest, CompareRequest, Endpoint, DeploymentError, Busy, NotFound
from test_comparisons import Runner, Shakedown, wait, project
from test_gcp_deployments import Gcp, DIGEST, URL
from test_aws_deployments import Aws

# 시운전 규칙 보고서(apps/shakedown/src/report.ts)가 GCP 로그인 풀림에 내는 수정안과 같은 값.
ENV_FIX = dict(target='gcp', option='env', value='SPRING_PROFILES_ACTIVE=demo,session-jdbc',
               description='Keep the login in the shared database (Spring Session JDBC) so every instance sees it.',
               native='Cloud Run / ECS env SPRING_PROFILES_ACTIVE=demo,session-jdbc (sessions in the spring_session table of Cloud SQL / RDS)',
               auto_applicable=True)
SPENT = dict(calls=1, input_tokens=1000, output_tokens=500, krw=19.6)
ZERO = dict(calls=0, input_tokens=0, output_tokens=0, krw=0)


def hints_sent(sd):
    return [body['hints'] for method, _, body in sd.calls if method == 'POST']


def posts(runner):
    return [body for method, _, body in runner.calls if method == 'POST']


class Runs(Shakedown):
    """시운전을 새로 시작할 때마다 다음 판정을 쓰는 가짜 시운전. BLOCKED 보고서에는 fix를, 회차마다 AI 비용을 넣는다."""
    def __init__(self, *results, fix=ENV_FIX, costs=None):
        super().__init__(results[0])
        self.results, self.fix, self.costs, self.cost = list(results), fix, list(costs or []), ZERO
    def call(self, method, path, body=None):
        if method == 'POST':
            self.result = self.results.pop(0)
            self.cost = self.costs.pop(0) if self.costs else ZERO
        state = super().call(method, path, body)
        state['ai_cost'] = dict(self.cost)
        if state.get('report') is not None: state['report']['fix'] = self.fix and dict(self.fix)
        return state


class GcpRejectsFix(Gcp):
    """env가 들어간 재배포 POST만 거절하는 GCP 어댑터. 실제 어댑터처럼 거절한 ID는 모르므로 그 ID 요청에는 404다."""
    rejected = None
    def call(self, method, path, body=None):
        if method == 'POST' and body.get('env'):
            self.calls.append((method, path, body)); self.rejected = body['deployment_id']
            raise DeploymentError('GCP Target request failed; inspect the adapter on 127.0.0.1:9103 and its deployment logs.')
        if self.rejected and path.startswith('/deployments/' + self.rejected):
            self.calls.append((method, path, body))
            raise NotFound('GCP Target request failed; inspect the adapter on 127.0.0.1:9103 and its deployment logs.')
        return super().call(method, path, body)


class GcpLosesFixResponse(Gcp):
    """env 재배포 POST를 접수(배포 시작)했지만 응답이 엔진에 닿지 않은 GCP 어댑터. down이면 그 뒤로 응답이 전혀 없다."""
    def __init__(self, down=False): super().__init__(); self.down = down; self.lost = None
    def call(self, method, path, body=None):
        if self.lost and self.down:
            self.calls.append((method, path, body)); raise DeploymentError('GCP Target request failed')
        state = super().call(method, path, body)
        if method == 'POST' and body.get('env'):
            self.lost = body['deployment_id']
            raise DeploymentError('GCP Target request failed; inspect the adapter on 127.0.0.1:9103 and its deployment logs.')
        return state


class GcpFixNeverReady(Gcp):
    """env 재배포 POST는 받지만 그 배포가 failed로 끝나는 GCP 어댑터."""
    fixed = None
    def call(self, method, path, body=None):
        state = super().call(method, path, body)
        if method == 'POST' and body.get('env'): self.fixed = body['deployment_id']
        if method == 'GET' and self.fixed and path == '/deployments/' + self.fixed: return {'status': 'failed'}
        return state


class RacingGcp(Gcp):
    """사전 확인(preflight) 도중 race()를 한 번 끼워 넣는 GCP 어댑터: 검사와 저장 사이에 다른 요청이 들어온 상황."""
    race = None
    def preflight(self, project):
        super().preflight(project)
        race, self.race = self.race, None
        if race: race()


class GcpHoldsFix(Gcp):
    """env 재배포를 release 전까지 deploying으로 붙잡는 GCP 어댑터: 수정 진행 중의 상태를 읽기 위해."""
    def __init__(self):
        super().__init__(); self.release = threading.Event(); self.fixed = None; self.polled = threading.Event()
    def call(self, method, path, body=None):
        state = super().call(method, path, body)
        if method == 'POST' and body.get('env'): self.fixed = body['deployment_id']
        if method == 'GET' and self.fixed and path == '/deployments/' + self.fixed and not self.release.is_set():
            self.polled.set()
            return {'status': 'deploying'}
        return state


def blocked_local_gcp(ds, project):
    d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
    assert d['status'] == 'blocked' and d['targets']['gcp']['cleanup'] == 'confirmed'
    return d


def test_only_engine_managed_gcp_is_offered_env_auto_fix(project, tmp_path):
    # env를 바꿔 다시 배포할 수 있는 건 엔진이 직접 배포한 GCP뿐이다. AWS는 실계정 검증 전이라 제안만 한다.
    sd = Shakedown()
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=Gcp(), aws=Aws(), shakedown=sd, poll_seconds=.001)
    try:
        for request in (DeployRequest(targets=['local', 'gcp'], shakedown=True),
                        DeployRequest(targets=['local', 'aws'], shakedown=True),
                        DeployRequest(shakedown=True, comparison=Endpoint(name='candidate', url='https://candidate.example')),
                        # GCP를 엔진이 배포했어도 비교 상대가 외부 URL이면 바뀌는 쪽(candidate)은 엔진 것이 아니다.
                        DeployRequest(targets=['gcp'], shakedown=True, comparison=Endpoint(name='candidate', url='https://candidate.example'))):
            assert wait(ds, ds.start(project, request)['id'])['status'] == 'promoted'
        compare = CompareRequest(baseline=Endpoint(name='local', url='http://127.0.0.1:18080'), candidate=Endpoint(name='candidate', url='https://candidate.example'))
        assert wait(ds, ds.start_comparison(project, compare)['id'])['status'] == 'promoted'
        session = project.analysis.uses_server_session
        assert hints_sent(sd) == [{'uses_server_session': session, 'can_apply_env': True},
                                  {'uses_server_session': session},
                                  {'uses_server_session': session},
                                  {'uses_server_session': session},
                                  {'uses_server_session': session}]
    finally: ds.close()


def test_blocked_gcp_fix_redeploys_same_digest_with_session_jdbc_and_promotes(project, tmp_path):
    gcp = Gcp(); local = Runner(); sd = Runs('BLOCKED', 'PASS')
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=sd, poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        assert gcp.calls[-1] == ('DELETE', '/deployments/' + id, None)

        fixing = ds.apply_fix(project, id)
        assert fixing['status'] == 'fixing' and fixing['attempts'][0]['applied_fix'] == ENV_FIX
        d = wait(ds, id)
        assert (d['status'], d['release_gate'], d['traffic_blocked']) == ('promoted', 'passed', False)
        assert [(a['n'], a['verdict']['status']) for a in d['attempts']] == [(1, 'BLOCKED'), (2, 'PASS')]
        assert d['attempts'][0]['applied_fix'] == ENV_FIX and 'applied_fix' not in d['attempts'][1]

        # 빌드 없이 1회차 digest를 그대로 쓰고, 본문은 env와 배포 ID만 다르다(포트·health·DB·옵션 그대로).
        first, second = posts(gcp)
        assert gcp.builds == 1 and first['deployment_id'] == id and first['image'] == second['image'] == DIGEST
        # 새 ID는 엔진 배포 ID와 같은 모양(36자)이다. 접미사로 늘리면 AWS ECS clientToken 36자 제한을 넘는다.
        assert re.fullmatch(r'dep_[0-9a-f]{32}', second['deployment_id']) and second['deployment_id'] != id
        assert 'env' not in first and second['env'] == {'SPRING_PROFILES_ACTIVE': 'demo,session-jdbc'}
        same = lambda body: {k: v for k, v in body.items() if k not in ('deployment_id', 'env')}
        assert same(second) == same(first)
        assert ('GET', '/deployments/' + second['deployment_id'], None) in gcp.calls

        # Local은 다시 배포하지 않는다. 2회차도 같은 Local과 다시 올린 GCP를 비교한다.
        assert [c[0] for c in local.calls] == ['POST', 'GET']
        assert [body['candidates'] for method, _, body in sd.calls if method == 'POST'] == [[{'name': 'gcp', 'url': URL}]] * 2
        # 2회차 수정안은 다시 자동 적용하지 않으므로 힌트를 주지 않는다.
        assert ['can_apply_env' in h for h in hints_sent(sd)] == [True, False]

        target = d['targets']['gcp']
        assert (target['status'], target['deployment_id'], target['url']) == ('ready', second['deployment_id'], URL)
        assert 'cleanup' not in target and 'logs_collected' not in target
        assert target['request'] == {k: v for k, v in second.items() if k != 'deployment_id'}
        assert ds.get(id) == d
    finally: ds.close()


def test_ai_cost_accumulates_across_attempts(project, tmp_path):
    # 2회차(PASS)는 AI를 부르지 않아 0원을 돌려준다. 1회차 비용이 지워지면 대시보드에 ₩0·0회로 보인다.
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=Gcp(), shakedown=Runs('BLOCKED', 'PASS', costs=[SPENT, ZERO]), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        assert ds.get(id)['ai_cost'] == SPENT
        ds.apply_fix(project, id)
        d = wait(ds, id)
        assert d['status'] == 'promoted' and d['ai_cost']['calls'] >= 1
        assert d['ai_cost'] == SPENT
    finally: ds.close()


@pytest.mark.parametrize('fix', [dict(ENV_FIX, auto_applicable=False), dict(ENV_FIX, option='sticky_sessions', value='true'),
                                 # 값은 허용 목록에 있어도 option이 env가 아니면 적용하지 않는다.
                                 dict(ENV_FIX, option='sticky_sessions'),
                                 # 보고서가 문자열 'true'처럼 참 값만 보내도 true로 보지 않는다(정확히 true만).
                                 dict(ENV_FIX, auto_applicable='true'),
                                 dict(ENV_FIX, target='local'), dict(ENV_FIX, value='SPRING_PROFILES_ACTIVE=prod'), None])
def test_fix_rejected_unless_report_has_whitelisted_env_fix(project, tmp_path, fix):
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED', fix=fix), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        with pytest.raises(DeploymentError) as error: ds.apply_fix(project, id)
        assert not isinstance(error.value, Busy)
        d = ds.get(id)
        assert d['status'] == 'blocked' and 'applied_fix' not in d['attempts'][0] and len(posts(gcp)) == 1
    finally: ds.close()


def test_fix_needs_confirmed_cleanup_of_the_blocked_gcp(project, tmp_path):
    # 1회차 GCP를 내렸다고 확인하지 못했으면 같은 서비스에 다시 배포하지 않는다.
    gcp = Gcp('cleanup'); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED'), poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        assert d['status'] == 'blocked' and d['targets']['gcp']['cleanup'] == 'failed'
        with pytest.raises(DeploymentError): ds.apply_fix(project, d['id'])
        assert ds.get(d['id'])['status'] == 'blocked' and len(posts(gcp)) == 1
    finally: ds.close()


@pytest.mark.parametrize('kind', ['aws', 'external', 'comparison'])
def test_fix_only_for_engine_managed_local_and_gcp(project, tmp_path, kind):
    # 보고서가 자동 적용 가능이라고 해도, 엔진이 배포한 Local+GCP가 아니면 엔진은 재배포하지 않는다.
    candidate = {'aws': 'aws', 'external': 'candidate', 'comparison': 'candidate'}[kind]
    aws = Aws(); local = Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, gcp=Gcp(), shakedown=Runs('BLOCKED', fix=dict(ENV_FIX, target=candidate)), poll_seconds=.001)
    endpoint = Endpoint(name='candidate', url='https://candidate.example')
    try:
        if kind == 'aws': started = ds.start(project, DeployRequest(targets=['local', 'aws'], shakedown=True))
        elif kind == 'external': started = ds.start(project, DeployRequest(shakedown=True, comparison=endpoint))
        else: started = ds.start_comparison(project, CompareRequest(baseline=Endpoint(name='local', url='http://127.0.0.1:18080'), candidate=endpoint))
        d = wait(ds, started['id'])
        assert d['status'] == 'blocked'
        calls = (list(local.calls), list(aws.calls))
        with pytest.raises(DeploymentError) as error: ds.apply_fix(project, d['id'])
        assert not isinstance(error.value, Busy)
        assert (local.calls, aws.calls) == calls and ds.get(d['id'])['status'] == 'blocked'
    finally: ds.close()


def test_fix_conflicts_when_not_blocked_or_already_fixing(project, tmp_path):
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('PASS', 'BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        passed = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        with pytest.raises(Busy): ds.apply_fix(project, passed['id'])
        id = blocked_local_gcp(ds, project)['id']
        ds.apply_fix(project, id)
        with pytest.raises(Busy): ds.apply_fix(project, id)
        assert wait(ds, id)['status'] == 'promoted' and len(posts(gcp)) == 3
    finally: ds.close()


def test_fix_only_the_latest_deployment_of_the_project(project, tmp_path):
    # 옛 차단 배포에 수정을 적용하면 GCP 서비스 하나를 쓰는 더 새 배포를 덮어쓴다(어댑터는 서비스 하나만 다룬다).
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        old = blocked_local_gcp(ds, project)['id']
        assert wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])['status'] == 'promoted'
        with pytest.raises(Busy, match='latest'): ds.apply_fix(project, old)
        assert len(posts(gcp)) == 2 and ds.get(old)['status'] == 'blocked' and 'applied_fix' not in ds.get(old)['attempts'][0]
    finally: ds.close()


def test_fix_blocked_again_stops_the_new_cloud_id_and_is_not_fixed_twice(project, tmp_path):
    # 0.1+0.2는 부동소수점으로 0.30000000000000004다. 회차 합을 소수 둘째 자리로 맞추는지 보려고 서로 다른 값을 쓴다.
    costs = [dict(SPENT, krw=0.1), dict(SPENT, krw=0.2)]
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED', 'BLOCKED', costs=costs), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        ds.apply_fix(project, id)
        d = wait(ds, id)
        new = posts(gcp)[1]['deployment_id']
        assert d['status'] == 'blocked' and [a['verdict']['status'] for a in d['attempts']] == ['BLOCKED', 'BLOCKED']
        assert gcp.calls[-2:] == [('GET', f'/deployments/{new}/logs', None), ('DELETE', f'/deployments/{new}', None)]
        assert (d['targets']['gcp']['status'], d['targets']['gcp']['cleanup'], d['traffic_blocked']) == ('stopped', 'confirmed', True)
        assert d['ai_cost'] == dict(calls=2, input_tokens=2000, output_tokens=1000, krw=0.3)
        with pytest.raises(DeploymentError) as error: ds.apply_fix(project, id)
        assert not isinstance(error.value, Busy) and len(posts(gcp)) == 2
    finally: ds.close()


def test_fix_conflicts_when_another_fix_or_deployment_slips_in_after_the_checks(project, tmp_path):
    # 검사를 통과한 뒤 저장하기 전에 같은 배포의 수정이 먼저 시작됐거나 같은 프로젝트의 새 배포가 생겼으면 저장하지 않는다.
    # 그대로 저장하면 수정 재배포가 두 번 돌거나, 새 배포가 쓰는 GCP 서비스를 옛 배포의 수정이 덮어쓴다.
    gcp = RacingGcp()
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED', 'PASS', 'BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        gcp.race = lambda: ds.apply_fix(project, id)
        with pytest.raises(Busy, match='changed'): ds.apply_fix(project, id)
        assert wait(ds, id)['status'] == 'promoted' and len(posts(gcp)) == 2

        id = blocked_local_gcp(ds, project)['id']
        newer = []
        gcp.race = lambda: newer.append(ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))['id'])
        with pytest.raises(Busy, match='changed'): ds.apply_fix(project, id)
        assert wait(ds, newer[0])['status'] == 'promoted' and len(posts(gcp)) == 4
        d = ds.get(id)
        assert d['status'] == 'blocked' and 'applied_fix' not in d['attempts'][0]
    finally: ds.close()


def test_fix_needs_the_engine_local_baseline_even_if_the_report_names_gcp(project, tmp_path):
    # GCP만 배포해 외부 URL과 비교한 배포에는 엔진이 띄운 Local 기준이 없다. 보고서가 gcp env 수정을
    # 자동 적용 가능이라고 해도 다시 배포하지 않는다.
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        external = Endpoint(name='candidate', url='https://candidate.example')
        d = wait(ds, ds.start(project, DeployRequest(targets=['gcp'], shakedown=True, comparison=external))['id'])
        assert d['status'] == 'blocked' and d['targets']['gcp']['cleanup'] == 'confirmed'
        with pytest.raises(DeploymentError) as error: ds.apply_fix(project, d['id'])
        assert not isinstance(error.value, Busy) and ds.get(d['id'])['status'] == 'blocked' and len(posts(gcp)) == 1
    finally: ds.close()


def test_fix_rejected_without_change_when_gcp_preflight_fails_or_first_request_is_missing(project, tmp_path):
    gcp = Gcp(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        # GCP 사전 확인 실패는 400이고 배포는 blocked 그대로다. fixing으로 바뀐 뒤 실패하면 프로젝트가 잠긴다.
        gcp.fail = 'config'
        with pytest.raises(DeploymentError, match='GCP not configured') as error: ds.apply_fix(project, id)
        assert not isinstance(error.value, Busy) and ds.get(id)['status'] == 'blocked' and len(posts(gcp)) == 1
        gcp.fail = None
        # 이 기능 전에 저장된 차단 배포에는 1회차 본문(request)이 없어서 같은 본문으로 다시 보낼 수 없다.
        d = ds.get(id)
        for key in ('request', 'deployment_id'): d['targets']['gcp'].pop(key)
        ds.save(d)
        with pytest.raises(DeploymentError) as error: ds.apply_fix(project, id)
        assert not isinstance(error.value, Busy) and ds.get(id)['status'] == 'blocked' and len(posts(gcp)) == 1
    finally: ds.close()


def test_fix_in_progress_reopens_the_cloud_and_keeps_the_project_busy(project, tmp_path):
    # 2회차 재배포가 공개 주소를 다시 여는 동안 1회차 차단 확인(traffic_blocked=true, cleanup=confirmed)이 남아 있으면
    # 공개 중인 GCP가 차단된 것처럼 보인다. 엔진이 이때 재시작해 failed로 닫혀도 그 값이 그대로 남는다.
    gcp = GcpHoldsFix(); ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        ds.apply_fix(project, id)
        assert gcp.polled.wait(2)
        d = ds.get(id)
        target = d['targets']['gcp']
        assert (d['status'], d['traffic_blocked'], 'cleanup' in target, target['status'], target['deployment_id']) == ('fixing', False, False, 'deploying', gcp.fixed)
        # 수정 중인 프로젝트에는 새 배포를 시작하지 않는다(같은 GCP 서비스를 쓴다).
        with pytest.raises(Busy): ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True))
        gcp.release.set()
        assert wait(ds, id)['status'] == 'promoted'
    finally:
        gcp.release.set(); ds.close()


@pytest.mark.parametrize('broken', ['failed', 'timeout'])
def test_fix_second_shakedown_failure_fails_and_stops_both(project, tmp_path, broken):
    # 2회차 시운전이 결과를 못 내면 PASS가 아니다. 다시 연 GCP와 Local을 모두 내리고 1회차 기록은 남긴다.
    gcp = Gcp(); local = Runner(); sd = Runs('BLOCKED', 'PASS')
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=sd, poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        sd.broken = broken
        if broken == 'timeout': ds.shakedown_timeout = .05
        ds.apply_fix(project, id)
        d = wait(ds, id)
        new = posts(gcp)[1]['deployment_id']
        assert d['status'] == 'failed' and len(d['attempts']) == 2 and 'verdict' not in d['attempts'][1]
        assert d['attempts'][0]['verdict']['status'] == 'BLOCKED' and d['attempts'][0]['applied_fix'] == ENV_FIX
        assert gcp.calls[-1] == ('DELETE', f'/deployments/{new}', None) and local.calls[-1] == ('DELETE', '/deployments/' + id, None)
        target = d['targets']['gcp']
        assert (target['status'], target['cleanup'], target['deployment_id'], d['traffic_blocked']) == ('stopped', 'confirmed', new, True)
    finally: ds.close()


def test_fix_timings_add_the_redeploy_but_not_the_wait_before_the_click(project, tmp_path):
    # 차단 뒤 사람이 버튼을 누르기까지 기다린 시간은 작업 시간이 아니다. total_s에 넣으면 '시운전 한 번 3분 안'과
    # 대시보드의 분해(빌드·배포·시운전)로 설명되지 않는 총시간이 보인다.
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=Gcp(), shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        first = blocked_local_gcp(ds, project)
        time.sleep(.5)
        fixing = ds.apply_fix(project, first['id'])
        # 수정 중에는 1회차 총시간을 지금 값처럼 보이지 않는다(끝나면 다시 채운다).
        assert 'total_s' not in fixing['timings']
        d = wait(ds, first['id'])
        before, after = first['timings'], d['timings']
        assert after['build_s'] == before['build_s']  # 다시 빌드하지 않는다
        assert after['deploy_s'] > before['deploy_s']  # GCP 재배포 시간을 더한다
        assert before['total_s'] < after['total_s'] < before['total_s'] + .5
    finally: ds.close()


def test_fix_post_rejected_keeps_the_first_cleanup(project, tmp_path):
    # 거절된 새 ID는 어댑터에 없다. 그 ID로 DELETE하면 404가 예외가 되어 이미 확인된 1회차 정리 기록이 failed로 바뀐다.
    gcp = GcpRejectsFix(); local = Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        ds.apply_fix(project, id)
        d = wait(ds, id)
        assert d['status'] == 'failed' and 'GCP Target request failed' in d['error'] and len(d['attempts']) == 1
        assert [c for c in gcp.calls if c[0] == 'DELETE'] == [('DELETE', '/deployments/' + id, None)]
        target = d['targets']['gcp']
        assert (target['status'], target['cleanup'], target['deployment_id'], d['traffic_blocked']) == ('stopped', 'confirmed', id, True)
        # 거절인지는 어댑터에 새 ID를 물어 404로 확인한다(응답만 잃은 경우와 구분).
        assert ('GET', '/deployments/' + gcp.rejected, None) in gcp.calls
        # 실패한 배포의 Local은 다른 실패처럼 정리한다.
        assert local.calls[-1] == ('DELETE', '/deployments/' + id, None) and d['targets']['local']['status'] == 'stopped'
    finally: ds.close()


def test_fix_post_response_lost_after_accept_still_stops_the_new_cloud_id(project, tmp_path):
    # 시간 초과·연결 끊김은 거절과 달리 어댑터가 이미 접수해 새 배포(2대, 공개)를 시작했을 수 있다.
    # 새 ID를 DELETE하지 않으면 엔진 기록에는 차단 확인으로 남은 채 공개 주소가 다시 열린다.
    gcp = GcpLosesFixResponse(); local = Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        ds.apply_fix(project, id)
        d = wait(ds, id)
        assert d['status'] == 'failed' and 'GCP Target request failed' in d['error'] and len(d['attempts']) == 1
        assert gcp.calls[-2:] == [('GET', f'/deployments/{gcp.lost}/logs', None), ('DELETE', f'/deployments/{gcp.lost}', None)]
        target = d['targets']['gcp']
        assert (target['status'], target['cleanup'], target['deployment_id'], d['traffic_blocked']) == ('stopped', 'confirmed', gcp.lost, True)
        assert local.calls[-1] == ('DELETE', '/deployments/' + id, None)
    finally: ds.close()


def test_fix_post_response_lost_and_adapter_down_records_unconfirmed_cleanup(project, tmp_path):
    # 접수됐는지도, 지웠는지도 모르면 차단 확인으로 적지 않는다. 새 ID와 정리 실패를 남겨 사람이 DELETE를 다시 하게 한다.
    gcp = GcpLosesFixResponse(down=True)
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=gcp, shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        ds.apply_fix(project, id)
        d = wait(ds, id)
        target = d['targets']['gcp']
        assert (d['status'], target['cleanup'], target['deployment_id'], d['traffic_blocked']) == ('failed', 'failed', gcp.lost, False)
        assert 'gcp cleanup failed' in d['error']
    finally: ds.close()


def test_gcp_runner_tells_unknown_deployment_apart_from_other_failures(monkeypatch):
    # 404(어댑터가 모르는 ID)만 재배포 POST가 거절됐다는 증거다. 500이나 연결 실패는 접수됐을 수도 있다.
    import httpx
    from engine import gcp_runner
    real = httpx.Client
    def handler(request):
        if request.url.path.endswith('/dep_down'): raise httpx.ConnectError('down', request=request)
        return httpx.Response(404 if request.url.path.endswith('/dep_missing') else 500)
    monkeypatch.setattr(gcp_runner.httpx, 'Client', lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    with pytest.raises(NotFound, match='GCP Target request failed'): gcp_runner.GcpRunner().call('GET', '/deployments/dep_missing')
    for id in ('dep_error', 'dep_down'):
        with pytest.raises(DeploymentError, match='GCP Target request failed') as error: gcp_runner.GcpRunner().call('GET', '/deployments/' + id)
        assert not isinstance(error.value, NotFound)


def test_fix_redeploy_failure_fails_and_cleans_up_both(project, tmp_path):
    gcp = GcpFixNeverReady(); local = Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, gcp=gcp, shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    try:
        id = blocked_local_gcp(ds, project)['id']
        ds.apply_fix(project, id)
        d = wait(ds, id)
        assert d['status'] == 'failed' and len(d['attempts']) == 1 and 'gcp deployment failed' in d['error']
        assert gcp.calls[-1] == ('DELETE', f'/deployments/{gcp.fixed}', None) and local.calls[-1][0] == 'DELETE'
        assert (d['targets']['gcp']['status'], d['targets']['gcp']['cleanup'], d['traffic_blocked']) == ('stopped', 'confirmed', True)
    finally: ds.close()


def test_fix_api_returns_202_then_promotes_and_rejects_unknown_or_repeat(store, project, tmp_path):
    from fastapi.testclient import TestClient
    from engine.api import create_app
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=Gcp(), shakedown=Runs('BLOCKED', 'PASS'), poll_seconds=.001)
    with TestClient(create_app(store, ds)) as client:
        r = client.post(f'/api/projects/{project.id}/deployments', json={'targets': ['local', 'gcp'], 'shakedown': True})
        id = r.json()['id']
        assert wait(ds, id)['status'] == 'blocked'
        r = client.post(f'/api/deployments/{id}/fix')
        assert r.status_code == 202 and r.json()['status'] == 'fixing'
        assert r.json()['attempts'][0]['applied_fix'] == ENV_FIX
        repeat = client.post(f'/api/deployments/{id}/fix')
        assert repeat.status_code == 409 and repeat.json()['detail']
        assert wait(ds, id)['status'] == 'promoted'
        assert client.post('/api/deployments/dep_missing/fix').status_code == 404
        assert '"status": "promoted"' in client.get(f'/api/deployments/{id}/events').text


def test_fix_api_returns_400_for_a_fix_that_is_not_auto_applicable(store, project, tmp_path):
    from fastapi.testclient import TestClient
    from engine.api import create_app
    ds = DeploymentStore(tmp_path/'d.db', Runner(), gcp=Gcp(), shakedown=Runs('BLOCKED', fix=dict(ENV_FIX, auto_applicable=False)), poll_seconds=.001)
    with TestClient(create_app(store, ds)) as client:
        id = client.post(f'/api/projects/{project.id}/deployments', json={'targets': ['local', 'gcp'], 'shakedown': True}).json()['id']
        assert wait(ds, id)['status'] == 'blocked'
        r = client.post(f'/api/deployments/{id}/fix')
        assert r.status_code == 400 and 'manually' in r.json()['detail']


def test_contract_fixture_fix_is_the_one_the_engine_applies():
    # 시운전 규칙 보고서는 이 fixture와 글자까지 같은 수정안을 낸다(apps/shakedown/test/report.test.ts).
    # 엔진 허용 목록·가짜 시운전 값이 그 수정안과 어긋나면 실제 연결에서 버튼이 400으로 끝나므로 여기서 묶어 둔다.
    import json
    from pathlib import Path
    from engine.deployments import ENV_FIXES, ENV_FIX_TARGETS
    fixture = json.loads((Path(__file__).resolve().parents[3] / 'packages/contracts/fixtures/deployment-blocked-then-fixed.json').read_text())
    fix = fixture['attempts'][0]['applied_fix']
    assert fixture['attempts'][0]['report']['fix'] == fix
    assert (fix['option'], fix['auto_applicable'], fix['value'] in ENV_FIXES) == ('env', True, True)
    # 정답 기록의 대상도 엔진이 실제로 env 수정을 적용하는 대상이어야 한다(지금은 gcp만).
    assert fix == ENV_FIX and fix['target'] in ENV_FIX_TARGETS
