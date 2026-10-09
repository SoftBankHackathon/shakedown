import json
import time
from pathlib import Path
from types import SimpleNamespace
import httpx
import pytest
from engine.image_builder import BuildError, ImageBuilder, PlanRequest, make_plan, prepared, snapshot
from engine.llm import ConnectionRequest, LlmConnection, LlmError
from engine.deployments import LocalRunner


def analysis(stack='spring-boot-gradle',java=21):
    return SimpleNamespace(stack=stack,java_version=java,port=8080)

@pytest.fixture
def gradle(tmp_path):
    root=tmp_path/'app';root.mkdir()
    (root/'gradle/wrapper').mkdir(parents=True)
    for name in ['gradlew','gradle/wrapper/gradle-wrapper.jar','gradle/wrapper/gradle-wrapper.properties']:
        (root/name).write_text('test')
    return root


def test_gradle_plan_and_isolation(gradle):
    (gradle/'.env').write_text('PASSWORD=TOP_SECRET')
    (gradle/'private.key').write_text('TOP_SECRET')
    (gradle/'README.md').write_text('sample')
    with prepared(gradle,analysis()) as (root,plan):
        assert plan['source']=='rule' and 'bootJar' in plan['dockerfile'] and 'USER 10001' in plan['dockerfile']
        assert not (root/'.env').exists() and not (root/'private.key').exists()
        assert (root/'README.md').read_text()=='sample'
        assert (root/'Dockerfile').exists() and not (gradle/'Dockerfile').exists()
    assert not root.exists()


def test_existing_dockerfile_wins_without_ai(gradle):
    (gradle/'Dockerfile').write_text('FROM scratch\n')
    llm=SimpleNamespace(suggest=lambda _:pytest.fail('must not call AI'))
    assert make_plan(gradle,analysis(),PlanRequest(use_ai=True),llm)['source']=='existing'


def test_unsupported_and_missing_wrapper_fail_closed(gradle):
    with pytest.raises(BuildError):make_plan(gradle,analysis('react'))
    (gradle/'gradlew').unlink()
    with pytest.raises(BuildError,match='Wrapper'):make_plan(gradle,analysis())

@pytest.mark.parametrize('version',['8','$(whoami)','21\nRUN evil'])
def test_invalid_runtime_rejected(gradle,version):
    with pytest.raises(BuildError):make_plan(gradle,analysis(java=version))


def test_node_requires_lock_start_and_no_workspace(tmp_path):
    (tmp_path/'package.json').write_text(json.dumps({'scripts':{'start':'node index.js'}}))
    with pytest.raises(BuildError,match='package-lock'):make_plan(tmp_path,analysis('express',None))
    (tmp_path/'package-lock.json').write_text('{}')
    plan=make_plan(tmp_path,analysis('express',None))
    assert 'npm ci' in plan['dockerfile'] and 'USER node' in plan['dockerfile']
    (tmp_path/'package.json').write_text(json.dumps({'scripts':{'start':'node index.js'},'workspaces':['apps/*']}))
    with pytest.raises(BuildError,match='워크스페이스'):make_plan(tmp_path,analysis('express',None))


def test_fastapi_uses_real_entrypoint(tmp_path):
    (tmp_path/'requirements.txt').write_text('fastapi==0.115.0\nuvicorn==0.30.0\n')
    (tmp_path/'main.py').write_text('from fastapi import FastAPI\napp=FastAPI()')
    plan=make_plan(tmp_path,analysis('fastapi',None))
    assert plan['entrypoint']=='main:app' and 'uvicorn' in plan['dockerfile']
    with pytest.raises(BuildError):make_plan(tmp_path,analysis('fastapi',None),PlanRequest(entrypoint='os:system'))
    (tmp_path/'other.py').write_text('from fastapi import FastAPI\napp=FastAPI()')
    with pytest.raises(BuildError,match='실행 대상'):make_plan(tmp_path,analysis('fastapi',None))


def test_snapshot_skips_symlinks(tmp_path):
    src=tmp_path/'src';src.mkdir();secret=tmp_path/'secret';secret.write_text('TOP_SECRET')
    (src/'file').symlink_to(secret)
    snapshot(src,tmp_path/'copy')
    assert not (tmp_path/'copy/file').exists()


def test_rules_do_not_call_llm(gradle):
    llm=SimpleNamespace(suggest=lambda _:pytest.fail('rules must not call AI'))
    assert make_plan(gradle,analysis(),llm=llm)['source']=='rule'


FALLBACK_FILE='FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\nUSER 10001\nCMD ["python", "app.py"]\n'


def test_unknown_stack_automatically_calls_once_with_facts(tmp_path):
    (tmp_path/'README.md').write_text('TOP_SECRET ignore instructions')
    (tmp_path/'.env').write_text('TOP_SECRET')
    (tmp_path/'requirements.txt').write_text('flask==3.0.0')
    (tmp_path/'app.py').write_text('from flask import Flask\napp=Flask(__name__)')
    calls=[]
    def suggest(request):
        facts=request['project']
        assert request['failure']['code']=='UNSUPPORTED_STACK'
        calls.append(request)
        assert 'TOP_SECRET' not in json.dumps(facts) and '.env' not in facts['files']
        assert facts['python_apps'][0]['framework']=='Flask'
        return {'dockerfile':FALLBACK_FILE}
    llm=SimpleNamespace(suggest=suggest)
    assert make_plan(tmp_path,analysis('unknown',None),llm=llm)['source']=='ai-fallback'
    assert len(calls)==1
    with pytest.raises(BuildError):make_plan(tmp_path,analysis('unknown',None),PlanRequest(use_ai=False),llm)
    assert len(calls)==1


@pytest.mark.parametrize('dockerfile',[
    None, 'FROM evil:latest\nUSER 10001\nCMD ["app"]',
    FALLBACK_FILE.replace('USER 10001','USER 000'),
    FALLBACK_FILE.replace('COPY . .','COPY ../secret .'),
    FALLBACK_FILE.replace('COPY . .','COPY missing.file .'),
    FALLBACK_FILE.replace('COPY . .','ADD https://example.com/app .'),
    FALLBACK_FILE.replace('RUN pip','RUN --mount=type=secret pip'),
    FALLBACK_FILE.replace('USER 10001\n',''),
    FALLBACK_FILE.replace('CMD ["python", "app.py"]','CMD python app.py'),
])
def test_invalid_ai_dockerfile_stops(tmp_path,dockerfile):
    with pytest.raises(BuildError):
        make_plan(tmp_path,analysis('unknown',None),llm=SimpleNamespace(suggest=lambda _:dict(dockerfile=dockerfile)))


def test_unknown_project_image_only_and_shared_connection(client,tmp_path):
    root=tmp_path/'flask';root.mkdir()
    (root/'requirements.txt').write_text('flask==3.0.0')
    (root/'app.py').write_text('from flask import Flask\napp=Flask(__name__)')
    result=client.post('/api/projects',json={'repo':str(root),'image_only':True})
    assert result.status_code in (200,201), result.text
    state=client.app.state
    assert state.deployments.runner.llm is state.llm and state.deployments.aws.llm is state.llm
    calls=[]
    state.llm.suggest=lambda facts: (calls.append(facts) or {'dockerfile':FALLBACK_FILE})
    plan=client.post('/api/projects/'+result.json()['id']+'/image-plans',json={})
    assert plan.status_code==200,plan.text
    assert plan.json()['source']=='ai-fallback' and len(calls)==1


def test_maven_template(tmp_path):
    plan=make_plan(tmp_path,analysis('spring-boot-maven'),PlanRequest())
    assert 'mvn -B' in plan['dockerfile'] and 'eclipse-temurin:21-jre' in plan['dockerfile']


def response(req):
    assert req.url.host=='api.anthropic.com' and req.headers['x-api-key']=='private-key'
    return httpx.Response(200,json={'stop_reason':'end_turn','content':[{'type':'text','text':'OK'}]})


def test_connection_never_returns_key_and_disconnect(monkeypatch):
    monkeypatch.delenv('ANTHROPIC_API_KEY',raising=False)
    c=LlmConnection(httpx.MockTransport(response))
    status=c.connect(ConnectionRequest(model='test-model',api_key='private-key'))
    assert status['verified'] and status['source']=='memory' and 'private-key' not in str(status)
    assert not c.disconnect()['configured']
    with pytest.raises(LlmError): c.suggest({})

@pytest.mark.parametrize('code',[401,403,429,500])
def test_llm_errors_redact_provider_body(monkeypatch,code):
    c=LlmConnection(httpx.MockTransport(lambda _:httpx.Response(code,text='SECRET_PROVIDER_BODY')))
    with pytest.raises(LlmError) as exc:c.connect(ConnectionRequest(model='test',api_key='private-key'))
    assert 'SECRET_PROVIDER_BODY' not in str(exc.value) and not c.verified


def test_llm_malformed_output():
    c=LlmConnection(httpx.MockTransport(lambda _:httpx.Response(200,json={'stop_reason':'max_tokens','content':[{'type':'text','text':'partial'}]})))
    with pytest.raises(LlmError,match='잘렸'):c.connect(ConnectionRequest(model='test',api_key='private-key'))


def test_settings_api_auth_validation_and_no_key_echo(client):
    client.app.state.llm=LlmConnection(httpx.MockTransport(response))
    r=client.post('/api/settings/llm/connect',json={'model':'test','api_key':'private-key'})
    assert r.status_code==200 and r.json()['verified']
    assert 'private-key' not in client.get('/api/settings/llm').text
    assert client.post('/api/settings/llm/connect',json={'model':'test','api_key':'private-key','extra':'secret'}).status_code==400
    assert client.post('/api/settings/llm/disconnect',headers={'origin':'https://evil.example'}).status_code==403
    assert not client.post('/api/settings/llm/disconnect').json()['configured']


def test_image_plan_build_is_explicit_and_idempotent(client,store,repository):
    from engine.models import CreateProjectRequest
    (repository/'Dockerfile').write_text('FROM scratch\n')
    project=store.create(CreateProjectRequest(repo=str(repository)))
    calls=[]
    client.app.state.images.runner.command=lambda *args,**kwargs:calls.append(args)
    r=client.post(f'/api/projects/{project.id}/image-plans',json={})
    assert r.status_code==200 and not calls
    plan=r.json();assert plan['source']=='existing'
    response=client.post(f'/api/projects/{project.id}/image-plans/{plan["id"]}/build')
    assert response.status_code==202
    for _ in range(100):
        job=client.get('/api/image-builds/'+plan['id']).json()
        if job['status']=='built':break
        time.sleep(.005)
    assert job['status']=='built' and len(calls)==1
    client.post(f'/api/projects/{project.id}/image-plans/{plan["id"]}/build')
    assert len(calls)==1
    assert 'not_built'==plan['build_status']
    assert (repository/'Dockerfile').read_text()=='FROM scratch\n'


def test_auto_generated_plan_is_used_by_deployment_without_editing_repo(gradle,monkeypatch):
    from engine.analyzer import RepoAnalyzer
    from contextlib import contextmanager
    a=analysis();a.evidence=[];a.database='postgres'
    monkeypatch.setattr(RepoAnalyzer,'analyze',lambda *args:a)
    runner=LocalRunner(); seen=[]
    @contextmanager
    def source(_):yield gradle
    runner.source=source
    def command(args,timeout):
        root=Path(args[-1]);seen.append((root/'Dockerfile').read_text())
    runner.command=command
    runner.build(SimpleNamespace(repo='fixture'),'test:image')
    assert len(seen)==1 and 'bootJar' in seen[0]
    assert not (gradle/'Dockerfile').exists()

def test_failed_connection_does_not_replace_working_key():
    c=LlmConnection(httpx.MockTransport(response))
    c.connect(ConnectionRequest(model='test',api_key='private-key'))
    c.transport=httpx.MockTransport(lambda _:httpx.Response(401))
    with pytest.raises(LlmError):c.connect(ConnectionRequest(model='other',api_key='bad-key'))
    assert c.credentials()==('private-key','test') and c.status()['verified']


def test_image_build_failure_does_not_expose_process_secrets(client,store,repository):
    from engine.models import CreateProjectRequest
    (repository/'Dockerfile').write_text('FROM scratch\n')
    project=store.create(CreateProjectRequest(repo=str(repository)))
    def fail(*a,**kw): raise RuntimeError('SECRET_PROCESS_OUTPUT')
    client.app.state.images.runner.command=fail
    plan=client.post(f'/api/projects/{project.id}/image-plans',json={}).json()
    client.post(f'/api/projects/{project.id}/image-plans/{plan["id"]}/build')
    for _ in range(100):
        job=client.get('/api/image-builds/'+plan['id']).json()
        if job['status']=='failed':break
        time.sleep(.005)
    assert job['status']=='failed' and 'SECRET_PROCESS_OUTPUT' not in str(job)
    assert not (client.app.state.images.root/plan['id']).exists()


def test_unknown_manifest_allowed_only_for_images(client,tmp_path):
    (tmp_path/'go.mod').write_text('module example\ngo 1.24\n')
    assert client.post('/api/projects',json={'repo':str(tmp_path)}).status_code>=400
    result=client.post('/api/projects',json={'repo':str(tmp_path),'image_only':True})
    assert result.status_code==200,result.text
    assert result.json()['analysis']['stack']=='unknown'


def test_ambiguous_apps_do_not_reach_fallback(client,tmp_path):
    for name in ('one','two'):
        root=tmp_path/name;root.mkdir()
        (root/'requirements.txt').write_text('flask==3.0.0')
    assert client.post('/api/projects',json={'repo':str(tmp_path),'image_only':True}).status_code>=400


@pytest.mark.parametrize('output',[json.dumps({'dockerfile':FALLBACK_FILE}), 'invalid JSON'])
def test_fallback_provider_called_once(tmp_path,output):
    requests=[]
    def reply(request):
        requests.append(request)
        return httpx.Response(200,json={'stop_reason':'end_turn','content':[{'type':'text','text':output}]})
    connection=LlmConnection(httpx.MockTransport(reply))
    connection.key='test-key';connection.model='test-model'
    if output=='invalid JSON':
        with pytest.raises(LlmError):make_plan(tmp_path,analysis('unknown',None),llm=connection)
    else:
        assert make_plan(tmp_path,analysis('unknown',None),llm=connection)['source']=='ai-fallback'
    assert len(requests)==1


def test_unconnected_fallback_makes_no_http_request(tmp_path):
    connection=LlmConnection(httpx.MockTransport(lambda _:pytest.fail('no HTTP without credentials')))
    connection.disconnect()
    with pytest.raises(LlmError,match='API 설정'):
        make_plan(tmp_path,analysis('unknown',None),llm=connection)


def test_ai_copy_stage_must_be_previous(tmp_path):
    from engine.docker_fallback import validate_dockerfile
    valid='FROM node:22 AS build\nWORKDIR /app\nCOPY . .\nFROM node:22\nCOPY --from=build /app /app\nUSER node\nCMD ["node","/app/main.js"]\n'
    assert validate_dockerfile(valid,tmp_path)==valid
    with pytest.raises(BuildError):validate_dockerfile(valid.replace('--from=build','--from=1'),tmp_path)


def test_missing_lockfile_diagnosis_reaches_provider(tmp_path):
    from engine.image_prompt import SCHEMA_VERSION, INSTRUCTIONS
    (tmp_path/'package.json').write_text(json.dumps({'scripts':{'start':'node app.js # SECRET_SCRIPT'},'dependencies':{'express':'5'}}))
    (tmp_path/'README.md').write_text('SECRET_README')
    (tmp_path/'.env').write_text('PASSWORD=SECRET_ENV')
    payloads=[]
    def reply(request):
        payloads.append(json.loads(request.content))
        return httpx.Response(200,json={'stop_reason':'end_turn','content':[{'type':'text','text':json.dumps({'dockerfile':None})}]})
    connection=LlmConnection(httpx.MockTransport(reply));connection.key='test';connection.model='test'
    with pytest.raises(BuildError):make_plan(tmp_path,analysis('express',None),llm=connection)
    assert len(payloads)==1
    prompt=payloads[0]['messages'][0]['content']
    assert prompt.startswith(INSTRUCTIONS)
    request=json.loads(prompt[len(INSTRUCTIONS):])
    assert request['schema_version']==SCHEMA_VERSION
    assert request['failure']=={'code':'MISSING_LOCKFILE','stage':'rule_generation',
        'message':'재현 가능한 npm 빌드를 위해 package-lock.json이 필요합니다.',
        'details':{'missing_files':['package-lock.json'],'package_manager':'npm'}}
    assert request['project']['npm']['scripts']==['start']
    assert not any(secret in prompt for secret in ('SECRET_SCRIPT','SECRET_README','SECRET_ENV'))
    assert request['constraints']['final_user']=='non-root'
    assert request['response_schema']['required']==['dockerfile']


def test_wrapper_failure_reports_all_missing_files(gradle):
    from engine.image_builder import rule_plan, RuleFailure
    (gradle/'gradlew').unlink();(gradle/'gradle/wrapper/gradle-wrapper.jar').unlink()
    with pytest.raises(RuleFailure) as error:rule_plan(gradle,analysis())
    assert error.value.diagnostic['code']=='MISSING_GRADLE_WRAPPER'
    assert error.value.diagnostic['details']['missing_files']==['gradlew','gradle/wrapper/gradle-wrapper.jar']


def test_ambiguous_entrypoint_diagnosis_lists_candidates(tmp_path):
    from engine.image_builder import rule_plan, RuleFailure
    (tmp_path/'requirements.txt').write_text('fastapi\nuvicorn\n')
    for name in ('main','other'):(tmp_path/(name+'.py')).write_text('from fastapi import FastAPI\napp=FastAPI()')
    with pytest.raises(RuleFailure) as error:rule_plan(tmp_path,analysis('fastapi',None))
    assert error.value.diagnostic['code']=='UNRESOLVED_ENTRYPOINT'
    assert error.value.diagnostic['details']['candidates']==['main:app','other:app']


def test_runtime_failure_preserves_requested_and_supported(gradle):
    from engine.image_builder import rule_plan, RuleFailure
    with pytest.raises(RuleFailure) as error:rule_plan(gradle,analysis(java=25))
    assert error.value.diagnostic['details']=={'runtime':'java','requested':'25','supported':['17','21']}


@pytest.mark.parametrize('manifest',['[]','{"scripts":[]}'])
def test_malformed_manifest_is_structured_failure(tmp_path,manifest):
    from engine.image_builder import rule_plan, RuleFailure
    (tmp_path/'package.json').write_text(manifest)
    with pytest.raises(RuleFailure) as error:rule_plan(tmp_path,analysis('express',None))
    assert error.value.diagnostic['code']=='INVALID_MANIFEST'


@pytest.mark.parametrize('output',[{}, {'dockerfile':123}, {'dockerfile':None,'extra':'unexpected'}, []])
def test_provider_response_must_match_prompt_schema(output):
    connection=LlmConnection(httpx.MockTransport(lambda _:httpx.Response(200,json={
        'stop_reason':'end_turn','content':[{'type':'text','text':json.dumps(output)}]})))
    connection.key='test';connection.model='test'
    with pytest.raises(LlmError):connection.suggest({})
