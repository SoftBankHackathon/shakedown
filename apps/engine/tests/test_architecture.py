import json
from types import SimpleNamespace
import httpx
import pytest
from engine.architecture import ArchitectureRequest, ArchitecturePlanner, ArchitectureError, collect, recommend, PROMPT
from engine.llm import LlmConnection, LlmError
from engine.models import CreateProjectRequest


def disconnected():
    connection=LlmConnection(httpx.MockTransport(lambda _:pytest.fail('must not call provider')))
    connection.disconnect()
    return connection


def requirements(**kwargs):
    return ArchitectureRequest(peak_rps=5,availability='best_effort',traffic='steady',**kwargs)


def facts(**signals):
    return {'stack':'express','workload':'http','signals':{'database':'postgres','local_storage':False,'server_session':False,'queue_dependency':False,'readme_hints':[],**signals},'evidence':[{'id':'repo.stack','value':'express','source':'static_analysis'}]}


@pytest.mark.parametrize('rps,availability,traffic,expected',[
    (0,'best_effort','steady','small'),(10,'best_effort','steady','small'),
    (11,'best_effort','steady','medium'),(100,'best_effort','steady','medium'),
    (101,'best_effort','steady','large'),(5,'high','steady','medium'),(5,'best_effort','bursty','medium')])
def test_minimum_tier_is_based_on_declared_requirements(rps,availability,traffic,expected):
    options=ArchitectureRequest(peak_rps=rps,availability=availability,traffic=traffic)
    plan=recommend(facts(),options,disconnected())
    assert plan['recommended_template']==expected
    assert plan['source']=='rule' and plan['status']=='proposed'
    assert plan['deployment']['ready'] is False


def test_unknown_traffic_not_inferred_from_source():
    plan=recommend(facts(),ArchitectureRequest(),disconnected())
    assert plan['status']=='needs_input'
    assert len(plan['assessment']['missing_inputs'])==3
    assert plan['requirements']['peak_rps'] is None


@pytest.mark.parametrize('signal',[{'local_storage':True},{'database':'mongodb'}])
def test_incompatible_data_model_blocks_selection(signal):
    plan=recommend(facts(**signal),requirements(),disconnected())
    assert plan['recommended_template'] is None
    assert not plan['assessment']['eligible_templates']


def test_non_http_not_forced_into_http_architecture():
    f=facts();f['workload']='worker'
    plan=recommend(f,requirements(),disconnected())
    assert plan['recommended_template'] is None
    assert plan['assessment']['blockers']


def test_fresh_repository_hints_no_secret_transmission(repository):
    (repository/'README.md').write_text('SECRET README text; sqs websocket local disk')
    options=ArchitectureRequest()
    f=collect(repository,options)
    assert set(f['signals']['readme_hints'])=={'queue','websocket','local_files'}
    assert f['signals']['server_session']
    assert 'SECRET' not in json.dumps(f) and 'NEVER_EMIT' not in json.dumps(f)
    assert f['evidence'][-1]['id']=='user.priority'


def ai(output):
    calls=[]
    def reply(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200,json={'content':[{'type':'text','text':json.dumps(output)}]})
    connection=LlmConnection(httpx.MockTransport(reply));connection.key='fake';connection.model='fake'
    return connection,calls


def test_ai_chooses_only_catalog_and_receives_versioned_request():
    connection,calls=ai({'template_id':'medium','reasons':['수평 확장 준비를 위한 초기 설계안입니다.'],'evidence_ids':['repo.stack']})
    plan=recommend(facts(),requirements(),connection)
    assert plan['source']=='ai' and plan['recommended_template']=='medium'
    assert len(calls)==1
    body=json.loads(calls[0]['messages'][0]['content'][len(PROMPT):])
    assert body['schema_version']=='aws-architecture.v1'
    assert len(body['catalog'])==3
    assert body['assessment']['minimum_tier']=='small'
    assert 'response_schema' in body


@pytest.mark.parametrize('output',[
    {'template_id':'invented','reasons':['x'],'evidence_ids':['repo.stack']},
    {'template_id':'small','reasons':['x'],'evidence_ids':['repo.stack']},
    {'template_id':'large','reasons':['x'],'evidence_ids':['invented']},
    {'template_id':'large','reasons':[],'evidence_ids':['repo.stack']},
    {'template_id':'large','reasons':['x'],'evidence_ids':['repo.stack'],'command':'run aws'},
])
def test_invalid_or_undersized_ai_decision_rejected(output):
    connection,calls=ai(output)
    with pytest.raises(ArchitectureError):recommend(facts(),ArchitectureRequest(peak_rps=1000),connection)
    assert len(calls)==1


def test_opt_out_makes_no_api_call():
    connection,calls=ai({})
    assert recommend(facts(),requirements(use_ai=False),connection)['source']=='rule'
    assert not calls


def test_provider_failure_does_not_silently_claim_ai_success():
    connection=LlmConnection(httpx.MockTransport(lambda _:httpx.Response(429,text='SECRET')))
    connection.key='fake';connection.model='fake'
    with pytest.raises(LlmError):recommend(facts(),requirements(),connection)


def test_api_plan_selection_persists_without_deployment(client,store,repository):
    project=store.create(CreateProjectRequest(repo=str(repository)))
    state=client.app.state
    state.llm.disconnect()
    state.deployments.runner.command=lambda *a,**kw:pytest.fail('no infrastructure commands')
    url=f'/api/projects/{project.id}/architecture-plans'
    assert client.get(url+'/latest').json() is None
    r=client.post(url,json=requirements().model_dump());assert r.status_code==200,r.text
    plan=r.json()
    assert client.post(url+'/'+plan['id']+'/select',json={'template_id':'medium'}).json()['selected_template']=='medium'
    reopened=ArchitecturePlanner(state.architecture.path,state.deployments.runner,state.llm)
    assert reopened.latest(project.id)['selected_template']=='medium'
    assert client.get('/api/deployments').json()==[]
    # Plan cannot be selected through another project namespace.
    with pytest.raises(ArchitectureError):reopened.select(SimpleNamespace(id='other-project'),plan['id'],'medium')


def test_missing_inputs_and_undersizing_cannot_be_selected(client,store,repository):
    project=store.create(CreateProjectRequest(repo=str(repository)))
    client.app.state.llm.disconnect()
    url=f'/api/projects/{project.id}/architecture-plans'
    p=client.post(url,json={}).json()
    assert client.post(url+'/'+p['id']+'/select',json={'template_id':'small'}).status_code==400
    p=client.post(url,json={'peak_rps':1000,'availability':'high','traffic':'steady'}).json()
    assert client.post(url+'/'+p['id']+'/select',json={'template_id':'small'}).status_code==400


@pytest.mark.parametrize('body',[{'peak_rps':-1},{'peak_rps':True},{'peak_rps':3.5},{'use_ai':'true'},{'provider':'unknown'}])
def test_invalid_requests_rejected(client,body):
    assert client.post('/api/projects/missing/architecture-plans',json=body).status_code==400


def test_origin_and_unknown_project(client):
    assert client.post('/api/projects/missing/architecture-plans',json={}).status_code==404
    assert client.post('/api/projects/missing/architecture-plans',json={},headers={'origin':'https://evil.example'}).status_code==403


def test_older_plan_cannot_replace_latest_selection(client,store,repository):
    project=store.create(CreateProjectRequest(repo=str(repository)))
    client.app.state.llm.disconnect()
    url=f'/api/projects/{project.id}/architecture-plans'
    old=client.post(url,json=requirements().model_dump()).json()
    new=client.post(url,json=requirements().model_dump()).json()
    assert client.post(url+'/'+old['id']+'/select',json={'template_id':'small'}).status_code==400
    assert client.post(url+'/'+new['id']+'/select',json={'template_id':'small'}).status_code==200


def test_ai_abstention_not_saved_as_approved_selection(client,store,repository):
    project=store.create(CreateProjectRequest(repo=str(repository)))
    connection,_=ai({'template_id':None,'reasons':['정보 부족'],'evidence_ids':['repo.stack']})
    client.app.state.architecture.llm=connection
    url=f'/api/projects/{project.id}/architecture-plans'
    p=client.post(url,json=requirements().model_dump()).json()
    assert p['recommended_template'] is None
    assert client.post(url+'/'+p['id']+'/select',json={'template_id':'small'}).status_code==400


def test_changed_analysis_evidence_requires_new_plan(client,store,repository):
    project=store.create(CreateProjectRequest(repo=str(repository)))
    client.app.state.llm.disconnect()
    url=f'/api/projects/{project.id}/architecture-plans'
    plan=client.post(url,json=requirements().model_dump()).json()
    (repository/'README.md').write_text('Requires websocket and local disk.')
    response=client.post(url+'/'+plan['id']+'/select',json={'template_id':'small'})
    assert response.status_code==400
    assert '분석 근거가 변경' in response.text
    assert client.get(url+'/latest').json()['selected_template'] is None
    fresh=client.post(url,json=requirements().model_dump()).json()
    assert client.post(url+'/'+fresh['id']+'/select',json={'template_id':'small'}).status_code==200


def test_selection_source_failure_is_sanitized(client,store,repository,monkeypatch):
    project=store.create(CreateProjectRequest(repo=str(repository)))
    client.app.state.llm.disconnect()
    url=f'/api/projects/{project.id}/architecture-plans'
    plan=client.post(url,json=requirements().model_dump()).json()
    def fail(*args):raise RuntimeError('SECRET')
    monkeypatch.setattr(client.app.state.architecture.runner,'source',fail)
    response=client.post(url+'/'+plan['id']+'/select',json={'template_id':'small'})
    assert response.status_code==400 and 'SECRET' not in response.text
    assert client.get(url+'/latest').json()['selected_template'] is None


def test_resolve_rejects_foreign_unselected_and_stale_plans(store,repository,tmp_path):
    from engine.deployments import LocalRunner
    gradle=repository/'build.gradle'
    gradle.write_text(gradle.read_text().replace('com.mysql:mysql-connector-j','org.postgresql:postgresql'))
    resources=repository/'src/main/resources/application.yml'
    resources.write_text(resources.read_text().replace('jdbc:mysql://db:3306','jdbc:postgresql://db:5432'))
    project=store.create(CreateProjectRequest(repo=str(repository),targets=['aws']))
    planner=ArchitecturePlanner(tmp_path/'plan.db',LocalRunner(),disconnected())
    plan=planner.create(project,requirements())
    with pytest.raises(ArchitectureError,match='최신'):planner.resolve(project,plan['id'])
    planner.select(project,plan['id'],'medium')
    spec=planner.resolve(project,plan['id'])
    assert spec['id']=='medium' and spec['cpu']==1024
    with pytest.raises(ArchitectureError):planner.resolve(SimpleNamespace(id='another',repo=project.repo),plan['id'])
    planner.create(project,requirements())
    with pytest.raises(ArchitectureError,match='최신'):planner.resolve(project,plan['id'])


@pytest.fixture(autouse=True)
def approved_security_gate(monkeypatch):
    # Unit tests for architecture/AWS behavior; negative gates have separate coverage.
    monkeypatch.setattr('engine.security.require_allow',lambda _: {'decision':'ALLOW'})


def test_explicit_mongodb_offers_tls_replica_set_architectures():
    f={**facts(database='mongodb'),'runtime_database':'mongodb'}
    plan=recommend(f,requirements(),disconnected())
    assert plan['assessment']['eligible_templates']==['small','medium','large']
    assert 'EC2 MongoDB' in plan['templates'][0]['database']
    high=ArchitectureRequest(peak_rps=5,availability='high',traffic='steady')
    assert recommend(f,high,disconnected())['recommended_template']=='medium'
