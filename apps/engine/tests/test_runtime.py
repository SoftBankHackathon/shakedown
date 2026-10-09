import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from engine.runtime import HttpRuntime
from engine.deployments import LocalRunner


def runtime(mode='none'):
    return HttpRuntime(port=3000,health_path='/health',database={'mode':mode,'name':'app','bindings':{'DB_HOST':'host','DB_PASSWORD':'password'} if mode=='postgres' else {}}).model_dump()


@pytest.mark.parametrize('patch',[
    {'env':{'DB_PASSWORD':'secret'}}, {'env':{'URL':'postgres://user:secret@host/db'}},
    {'secret_refs':{'KEY':'arn:aws:secretsmanager:any'}}, {'env':{'PORT':'8080'}},
    {'database':{'mode':'postgres'}}, {'init_command':['python','migrate.py']},
    {'health_path':'//evil'}, {'env':{'X':'a'},'secret_refs':{'X':'ref'}},
])
def test_invalid_runtime(patch):
    with pytest.raises(ValidationError):HttpRuntime.model_validate({**runtime(),**patch})


def test_runtime_persists_and_rejects_secret_input(client,repository):
    project=client.post('/api/projects',json={'repo':str(repository)}).json()
    path=f"/api/projects/{project['id']}/runtime"
    assert client.post(path,json=runtime()).status_code==200
    assert client.get(f"/api/projects/{project['id']}").json()['runtime']==runtime()
    r=client.post(path,json={**runtime(),'env':{'API_KEY':'NEVER_ECHO'}})
    assert r.status_code==400 and 'NEVER_ECHO' not in r.text


@pytest.mark.parametrize('stack',['node','python'])
def test_generic_build_uses_runtime_port_and_snapshot(tmp_path,monkeypatch,stack):
    if stack=='node':
        (tmp_path/'package.json').write_text(json.dumps({'scripts':{'start':'node app.js'},'dependencies':{'express':'5'}}))
        (tmp_path/'package-lock.json').write_text('{}')
    else:
        (tmp_path/'requirements.txt').write_text('fastapi\nuvicorn\n')
        (tmp_path/'main.py').write_text('from fastapi import FastAPI\napp=FastAPI()')
    monkeypatch.setattr('engine.security.require_allow',lambda _: {'decision':'ALLOW'})
    runner=LocalRunner();commands=[]
    def command(args,timeout):
        commands.append(args)
        assert '3000' in (Path(args[-1])/'Dockerfile').read_text()
        assert Path(args[-1])!=tmp_path
    runner.command=command
    analysis=runner.build(SimpleNamespace(repo=str(tmp_path),runtime=runtime()),'test')
    assert analysis.port==3000 and analysis.health_path=='/health' and len(commands)==1


def test_runtime_change_invalidates_architecture(client,repository,monkeypatch):
    monkeypatch.setattr('engine.security.require_allow',lambda _: {'decision':'ALLOW'})
    project=client.post('/api/projects',json={'repo':str(repository)}).json()
    path=f"/api/projects/{project['id']}"
    client.post(path+'/runtime',json=runtime())
    plan=client.post(path+'/architecture-plans',json={'workload':'http','peak_rps':5,'availability':'best_effort','traffic':'steady','use_ai':False}).json()
    client.post(path+'/runtime',json={**runtime(),'port':4000})
    result=client.post(path+f"/architecture-plans/{plan['id']}/select",json={'template_id':'small'})
    assert result.status_code==400 and '변경' in result.text


@pytest.mark.parametrize('mode',['none','postgres'])
@pytest.mark.parametrize('target',['local','aws'])
def test_runtime_crosses_engine_adapter_boundary(store,repository,tmp_path,mode,target):
    from engine.models import CreateProjectRequest
    from engine.deployments import DeploymentStore,DeployRequest
    from test_deployments import Runner
    from test_aws_deployments import Aws
    from test_comparisons import wait
    project=store.create(CreateProjectRequest(repo=str(repository)))
    project=store.set_runtime(project.id,HttpRuntime.model_validate(runtime(mode)))
    local=Runner();aws=Aws()
    ds=DeploymentStore(tmp_path/'runtime-deploy.db',local,aws=aws,poll_seconds=.001)
    try:
        result=wait(ds,ds.start(project,DeployRequest(targets=[target]))['id'])
        assert result['status']=='deployed'
        calls=(aws if target=='aws' else local).calls
        body=next(c[2] for c in calls if c[0]=='POST')
        assert body['runtime']==runtime(mode)
        assert body['port']==3000 and body['health_path']=='/health'
        assert 'database' not in body and 'secret_refs' not in body and 'env' not in body
    finally:ds.close()


def test_image_plan_uses_saved_runtime_port(tmp_path, monkeypatch):
    from engine.image_builder import ImageBuilder
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'package.json').write_text(json.dumps({'scripts': {'start': 'node app.js'}, 'dependencies': {'express': '5'}}))
    (source / 'package-lock.json').write_text('{}')
    monkeypatch.setattr('engine.security.require_allow', lambda _: {'decision': 'ALLOW'})
    builder = ImageBuilder(tmp_path / 'plans', None, LocalRunner())
    try:
        plan = builder.plan(SimpleNamespace(id='test', repo=str(source), runtime=runtime()), {})
        assert plan['port'] == 3000
        assert '3000' in plan['dockerfile']
    finally:
        builder.pool.shutdown()
