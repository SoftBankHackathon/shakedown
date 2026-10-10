"""Engine/AWS boundary tests: no AWS account, network, Docker or costs."""
import json
import pytest
from engine.deployments import DeploymentStore, DeployRequest, DeploymentError
from engine.aws_runner import AwsRunner
from test_comparisons import Runner, Shakedown, wait, project

DIGEST = '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/board@sha256:' + 'a' * 64
URL = 'http://board.ap-northeast-2.elb.amazonaws.com'

class Aws:
    def __init__(self, fail=None): self.calls = []; self.fail = fail; self.builds = 0
    def preflight(self, project):
        if self.fail == 'config': raise DeploymentError('AWS not configured')
    def build_publish(self, project, id):
        self.builds += 1
        if self.fail == 'build': raise RuntimeError('PRIVATE_TOKEN')
        return project.analysis, DIGEST
    def valid_url(self, url): return url == URL
    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == 'DELETE' and self.fail == 'cleanup': raise RuntimeError('PRIVATE_TOKEN')
        if method == 'POST' and self.fail == 'post': raise DeploymentError('AWS transport failed')
        if method == 'DELETE': return None
        if path.endswith('/logs'): return []
        return {'status': 'ready', 'url': 'http://evil.example' if self.fail == 'url' else URL, 'instances':2}

@pytest.mark.parametrize('reported', [URL, 'https://app.example.com'])
@pytest.mark.parametrize('verdict', ['PASS', 'BLOCKED'])
def test_aws_https_flows_into_shakedown_and_blocked_still_collects_logs_before_delete(project, tmp_path, reported, verdict):
    import httpx
    from engine.https_client import HttpsClient
    class SecureAws(Aws):
        def call(self, method, path, body=None):
            result = super().call(method, path, body)
            if result and isinstance(result, dict) and result.get('status') == 'ready':
                result['url'] = reported
            return result
    aws = SecureAws(); sd = Shakedown(verdict)
    ds = DeploymentStore(tmp_path/'https.db', Runner(), aws=aws, shakedown=sd, poll_seconds=.001)
    def registry(request):
        if '/targets/local/' in request.url.path: return httpx.Response(404)
        return httpx.Response(200, json={'project_id':project.id,'target':'aws','status':'ready',
            'domain':'app.example.com','https_url':'https://app.example.com','origin_url':URL,
            'certificate':{'expires_at':'2099-01-01T00:00:00Z'},'checked_at':'2026-10-09T00:00:00Z',
            'traffic_blocked':False})
    ds.https = HttpsClient('http://127.0.0.1:9301', httpx.MockTransport(registry))
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=['local','aws'],shakedown=True))['id'])
        assert d['status'] == ('promoted' if verdict == 'PASS' else 'blocked')
        assert sd.calls[0][2]['candidates'][0] == {'name':'aws','url':'https://app.example.com'}
        if verdict == 'BLOCKED':
            assert aws.calls[-2][1].endswith('/logs') and aws.calls[-1][0] == 'DELETE'
            assert d['traffic_blocked'] is True
    finally: ds.close()

@pytest.mark.parametrize('targets', [['aws'], ['local', 'aws']])
def test_selected_targets_use_digest_and_real_comparison(project, tmp_path, targets):
    aws = Aws(); local = Runner(); sd = Shakedown()
    ds = DeploymentStore(tmp_path/'d.db', local, aws=aws, shakedown=sd, poll_seconds=.001)
    try:
        d = wait(ds, ds.start(project, DeployRequest(targets=targets, shakedown=len(targets)==2))['id'])
        assert d['status'] == ('promoted' if len(targets)==2 else 'deployed')
        assert list(d['targets']) == targets and d['image'] == DIGEST and aws.builds == 1
        assert aws.calls[0][2]['image'] == DIGEST
        if len(targets)==2:
            assert local.calls[0][2]['image'] == DIGEST
            assert sd.calls[0][2]['candidates'][0] == {'name':'aws', 'url':URL}
        else: assert local.calls == [] and sd.calls == []
    finally: ds.close()

@pytest.mark.parametrize('failure', ['post', 'url', 'build'])
def test_failures_do_not_leak_secrets_and_cleanup_both(project, tmp_path, failure):
    aws=Aws(failure); local=Runner()
    ds=DeploymentStore(tmp_path/'d.db', local, aws=aws, poll_seconds=.001)
    try:
        d=wait(ds,ds.start(project,DeployRequest(targets=['local','aws'],shakedown=True))['id'])
        assert d['status']=='failed' and 'PRIVATE_TOKEN' not in str(d)
        assert any(c[0]=='DELETE' for c in aws.calls) == (failure != 'build')
        assert any(c[0]=='DELETE' for c in local.calls) == (failure != 'build')
    finally: ds.close()

@pytest.mark.parametrize('cleanup_failure', [False, True])
def test_blocked_stops_only_managed_aws_after_logs(project, tmp_path, cleanup_failure):
    aws=Aws('cleanup' if cleanup_failure else None); local=Runner()
    ds=DeploymentStore(tmp_path/'d.db',local,aws=aws,shakedown=Shakedown('BLOCKED'),poll_seconds=.001)
    try:
        d=wait(ds,ds.start(project,DeployRequest(targets=['local','aws'],shakedown=True))['id'])
        assert d['status']=='blocked' and d['traffic_blocked'] is (not cleanup_failure)
        assert aws.calls[-2][1].endswith('/logs') and aws.calls[-1][0]=='DELETE'
        assert not any(c[0]=='DELETE' for c in local.calls)
        assert 'PRIVATE_TOKEN' not in str(d)
    finally: ds.close()

@pytest.mark.parametrize('body', [dict(targets=['aws','aws']), dict(targets=['local','aws']), dict(targets=['aws'],options={'aws':{'replicas':3}}), dict(targets=['aws'],options={'aws':{'replicas':True}}), dict(targets=['aws'],options={'aws':{'sticky_sessions':True}})])
def test_invalid_selection_rejected_before_build(project,tmp_path,body):
    aws=Aws(); ds=DeploymentStore(tmp_path/'d.db',Runner(),aws=aws)
    try:
        with pytest.raises(DeploymentError): ds.start(project,DeployRequest(**body))
        assert not aws.calls and not aws.builds
    finally: ds.close()

def test_missing_aws_configuration_is_clear(monkeypatch):
    monkeypatch.delenv('AWS_ADAPTER_CONFIG',raising=False)
    monkeypatch.delenv('HACKATHON_PUBLISH_PROFILE',raising=False)
    with pytest.raises(DeploymentError,match='AWS_ADAPTER_CONFIG'): AwsRunner().config()

@pytest.fixture
def configured(monkeypatch,tmp_path,project):
    config={'accountId':'123456789012','region':'ap-northeast-2','repository':'board','repositoryUri':DIGEST.split('@')[0],
            'projectId':project.id,'port':project.analysis.port,'dbName':project.analysis.database_name or 'board_db','publicUrl':URL}
    path=tmp_path/'aws.json';path.write_text(json.dumps(config))
    monkeypatch.setenv('AWS_ADAPTER_CONFIG',str(path));monkeypatch.setenv('HACKATHON_PUBLISH_PROFILE','test-publisher')
    return config,path

def test_account_mismatch_fails_before_adapter(monkeypatch,configured,project):
    runner=AwsRunner();monkeypatch.setattr(runner,'capture',lambda *a,**k:'999999999999')
    with pytest.raises(DeploymentError,match='account'):runner.preflight(project)

def test_project_mismatch_before_any_aws_call(configured,project):
    config,path=configured;config['projectId']='prj_other';path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError,match='projectId'):AwsRunner().preflight(project)

def test_publish_pins_digest_and_keeps_token_off_argv(monkeypatch,configured,project):
    runner=AwsRunner(); calls=[]
    monkeypatch.setattr(runner,'preflight',lambda p:None)
    monkeypatch.setattr(runner,'build',lambda p,i,platform: p.analysis if platform=='linux/amd64' else None)
    def capture(args,**kwargs):
        calls.append((args,kwargs))
        if 'get-login-password' in args:return 'TOKEN_DO_NOT_LOG'
        if 'describe-images' in args:return 'sha256:'+'a'*64
        if 'context' in args:return 'unix:///tmp/docker.sock'
        return ''
    monkeypatch.setattr(runner,'capture',capture)
    monkeypatch.setattr(runner,'command',lambda args,timeout,env=None:calls.append((args,{'env':env})))
    analysis,image=runner.build_publish(project,'dep_test')
    assert image==DIGEST and analysis==project.analysis
    assert not any('TOKEN_DO_NOT_LOG' in ' '.join(args) for args,_ in calls)
    login=next(kw for args,kw in calls if 'login' in args)
    assert login['input']==b'TOKEN_DO_NOT_LOG'
    assert any('pull' in args and DIGEST in args for args,_ in calls)
    from pathlib import Path
    assert not Path(login['env']['DOCKER_CONFIG']).exists()

def test_missing_config_api_returns_actionable_error_without_job(store,project,tmp_path,monkeypatch):
    from fastapi.testclient import TestClient
    from engine.api import create_app
    monkeypatch.delenv('AWS_ADAPTER_CONFIG',raising=False)
    ds=DeploymentStore(tmp_path/'d.db',Runner())
    with TestClient(create_app(store,ds)) as client:
        response=client.post(f'/api/projects/{project.id}/deployments',json={'targets':['aws']})
        assert response.status_code==400 and 'AWS_ADAPTER_CONFIG' in response.json()['detail']
        assert ds.list()==[]

def test_aws_timeout_attempts_delete(project,tmp_path):
    aws=Aws(); ds=DeploymentStore(tmp_path/'d.db',Runner(),aws=aws,timeout=0)
    try:
        d=wait(ds,ds.start(project,DeployRequest(targets=['aws']))['id'])
        assert d['status']=='failed' and 'timed out' in d['error']
        assert aws.calls[-1][0]=='DELETE' and d['targets']['aws']['status']=='stopped'
    finally: ds.close()

def test_two_target_order_is_stable(project,tmp_path):
    aws=Aws(); sd=Shakedown(); ds=DeploymentStore(tmp_path/'d.db',Runner(),aws=aws,shakedown=sd,poll_seconds=.001)
    try:
        d=wait(ds,ds.start(project,DeployRequest(targets=['aws','local'],shakedown=True))['id'])
        assert d['status']=='promoted' and sd.calls[0][2]['baseline']['name']=='local'
    finally: ds.close()

@pytest.mark.parametrize('patch',[{'region':'us-east-1'},{'repositoryUri':'foreign.example/board'},{'publicUrl':'http://evil.example'},{'accountId':'invalid'}])
def test_config_rejects_mismatched_resources(configured,patch):
    config,path=configured;config.update(patch);path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError,match='Invalid AWS'):AwsRunner().config()

@pytest.mark.parametrize('tier,count', [('small',1),('medium',2),('large',3)])
def test_selected_plan_crosses_engine_boundary_with_catalog_only(project,tmp_path,tier,count):
    from engine.architecture import CATALOG
    class Planner:
        def resolve(self,p,id):
            assert p.id==project.id and id=='arch_'+'a'*32
            return dict(next(t for t in CATALOG if t['id']==tier))
    aws=Aws();aws.validate_architecture=lambda spec,project=None:None
    ds=DeploymentStore(tmp_path/'d.db',Runner(),aws=aws,poll_seconds=.001);ds.architecture=Planner()
    try:
        d=wait(ds,ds.start(project,DeployRequest(targets=['aws'],architecture_plan_id='arch_'+'a'*32))['id'])
        assert d['status']=='deployed' and d['architecture']['id']==tier
        body=next(c[2] for c in aws.calls if c[0]=='POST')
        assert body['architecture']=={'version':'aws-architecture.v1','template_id':tier}
        assert body['options']['replicas']==count
        assert body['env']['SPRING_PROFILES_ACTIVE']=='demo,session-jdbc'
    finally:ds.close()

@pytest.mark.parametrize('targets,options',[(['local'],{}),(['aws'],{'aws':{'replicas':2}})])
def test_plan_target_and_replica_conflicts_never_build(project,tmp_path,targets,options):
    class Planner:
        def resolve(self,*_):return {'id':'medium','min_tasks':2}
    aws=Aws();ds=DeploymentStore(tmp_path/'d.db',Runner(),aws=aws);ds.architecture=Planner()
    try:
        with pytest.raises(DeploymentError):ds.start(project,DeployRequest(targets=targets,options=options,architecture_plan_id='arch_'+'a'*32))
        assert aws.builds==0 and ds.list()==[]
    finally:ds.close()


def test_api_select_to_deploy_uses_real_planner(store,repository,tmp_path):
    from fastapi.testclient import TestClient
    from engine.api import create_app
    from engine.models import CreateProjectRequest
    from engine.deployments import LocalRunner
    gradle=repository/'build.gradle'
    gradle.write_text(gradle.read_text().replace('com.mysql:mysql-connector-j','org.postgresql:postgresql'))
    resource=repository/'src/main/resources/application.yml'
    resource.write_text(resource.read_text().replace('jdbc:mysql://db:3306','jdbc:postgresql://db:5432'))
    p=store.create(CreateProjectRequest(repo=str(repository),targets=['aws']))
    aws=Aws();aws.validate_architecture=lambda _,project=None:None
    ds=DeploymentStore(tmp_path/'d.db',LocalRunner(),aws=aws,poll_seconds=.001)
    with TestClient(create_app(store,ds)) as client:
        base=f'/api/projects/{p.id}'
        plan=client.post(base+'/architecture-plans',json={'peak_rps':50,'availability':'high','traffic':'steady','use_ai':False}).json()
        selected=client.post(base+f"/architecture-plans/{plan['id']}/select",json={'template_id':'medium'})
        assert selected.status_code==200 and selected.json()['deployment']['ready']
        response=client.post(base+'/deployments',json={'targets':['aws'],'architecture_plan_id':plan['id']})
        assert response.status_code==202
        d=wait(ds,response.json()['id']);assert d['status']=='deployed'
        assert next(c[2] for c in aws.calls if c[0]=='POST')['architecture']['template_id']=='medium'


@pytest.fixture(autouse=True)
def approved_security_gate(monkeypatch):
    # Unit tests for architecture/AWS behavior; negative gates have separate coverage.
    monkeypatch.setattr('engine.security.require_allow',lambda _: {'decision':'ALLOW'})
