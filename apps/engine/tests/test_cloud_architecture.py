"""A selected architecture plan applies the same tier to every selected cloud (AWS, GCP, Azure); Local is untouched."""
import pytest
from engine.architecture import CATALOG
from engine.deployments import DeploymentStore, DeployRequest, DeploymentError
from test_comparisons import Runner, wait, project
from test_aws_deployments import Aws
from test_azure_deployments import Azure, PerCandidate
from test_gcp_deployments import Gcp, RUNTIME
from test_fixes import Runs

PLAN = 'arch_' + 'a' * 32

class Planner:
    def __init__(self, tier='medium'): self.tier = tier
    def resolve(self, p, id): return dict(next(t for t in CATALOG if t['id'] == self.tier))

def store(tmp_path, tier='medium', shakedown=None):
    gcp, aws, azure, local = Gcp(), Aws(), Azure(), Runner()
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, azure=azure, gcp=gcp, poll_seconds=.001,
                         shakedown=shakedown or PerCandidate({'aws': 'PASS', 'azure': 'PASS', 'gcp': 'PASS'}))
    ds.architecture = Planner(tier)
    return ds, dict(local=local, aws=aws, azure=azure, gcp=gcp)

def post(runner): return next(c[2] for c in runner.calls if c[0] == 'POST')

@pytest.mark.parametrize('cloud', ['gcp', 'azure'])
@pytest.mark.parametrize('tier,count', [('small', 1), ('medium', 2), ('large', 3)])
def test_plan_applies_to_gcp_and_azure_without_aws(project, tmp_path, cloud, tier, count):
    # The fake Aws has no validate_architecture: calling it without AWS selected would fail this test.
    ds, r = store(tmp_path, tier)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=[cloud], architecture_plan_id=PLAN))['id'])
        assert d['status'] == 'deployed' and d['options'][cloud]['replicas'] == count
        body = post(r[cloud])
        assert body['architecture'] == {'version': f'{cloud}-architecture.v1', 'template_id': tier}
        assert body['options']['replicas'] == count and body['env'] == {'SPRING_PROFILES_ACTIVE': 'demo,session-jdbc'}
        assert r['aws'].calls == []
    finally: ds.close()

def test_plan_applies_to_every_selected_cloud_but_not_local(project, tmp_path):
    ds, r = store(tmp_path, 'large')
    checked = []; r['aws'].validate_architecture = lambda spec, project=None: checked.append(spec['id'])
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'aws', 'azure', 'gcp'], shakedown=True, architecture_plan_id=PLAN))['id'])
        assert d['status'] == 'promoted' and checked == ['large']
        for cloud in ('aws', 'azure', 'gcp'):
            assert post(r[cloud])['architecture'] == {'version': f'{cloud}-architecture.v1', 'template_id': 'large'}
            assert d['options'][cloud]['replicas'] == 3
        # 계획 배포는 세 클라우드 모두 세션을 공유 DB에 둔다(GCP 어댑터는 이 프로필 없이는 거절).
        for cloud in ('aws', 'azure', 'gcp'): assert post(r[cloud])['env'] == {'SPRING_PROFILES_ACTIVE': 'demo,session-jdbc'}
        local = post(r['local'])
        assert 'architecture' not in local and 'env' not in local and local['options']['replicas'] == 1
    finally: ds.close()

@pytest.mark.parametrize('targets,options,message', [
    (['local'], {}, 'An architecture plan requires a cloud target (AWS, GCP or Azure).'),
    (['local', 'gcp'], {'gcp': {'replicas': 2}}, 'GCP Cloud Run replicas'),
    (['local', 'azure'], {'azure': {'replicas': 1}}, 'Azure Container Apps replicas'),
    (['gcp', 'azure'], {'azure': {'replicas': 2}}, 'Azure Container Apps replicas')])
def test_plan_without_cloud_or_with_replica_override_never_builds(project, tmp_path, targets, options, message):
    ds, r = store(tmp_path)
    try:
        with pytest.raises(DeploymentError, match=message.replace('(', r'\(').replace(')', r'\)')):
            ds.start(project, DeployRequest(targets=targets, shakedown=len(targets) > 1, options=options, architecture_plan_id=PLAN))
        assert ds.list() == [] and not any(x.calls for x in r.values()) and r['gcp'].builds == 0
    finally: ds.close()

def test_runtime_project_gets_the_plan_without_the_session_env(project, tmp_path):
    ds, r = store(tmp_path)
    try:
        saved = project.model_copy(update={'runtime': RUNTIME})
        d = wait(ds, ds.start(saved, DeployRequest(targets=['gcp'], architecture_plan_id=PLAN))['id'])
        body = post(r['gcp'])
        assert d['status'] == 'deployed' and body['architecture']['template_id'] == 'medium' and 'env' not in body
    finally: ds.close()

def test_large_plan_on_local_gcp_still_offers_and_applies_the_fix(project, tmp_path):
    # replicas 3 must not change which cloud the env fix targets; the redeploy keeps the plan.
    sd = Runs('BLOCKED', 'PASS')
    ds, r = store(tmp_path, 'large', sd)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local', 'gcp'], shakedown=True, architecture_plan_id=PLAN))['id'])
        assert d['status'] == 'blocked' and d['options']['gcp']['replicas'] == 3
        assert next(b for m, _, b in sd.calls if m == 'POST')['hints'].get('can_apply_env') is True
        ds.apply_fix(project, d['id'])
        assert wait(ds, d['id'])['status'] == 'promoted'
        fixed = [b for m, _, b in r['gcp'].calls if m == 'POST'][-1]
        assert fixed['architecture'] == {'version': 'gcp-architecture.v1', 'template_id': 'large'} and fixed['options']['replicas'] == 3
    finally: ds.close()
