import json
from pathlib import Path
from types import SimpleNamespace
from contextlib import contextmanager

import pytest
from engine import security
from engine.image_builder import ImageBuilder, PlanRequest, prepared
from engine.deployments import LocalRunner, DeploymentError


def report(decision='ALLOW'):
    payload = json.loads((security.GATE_ROOT / 'examples' / 'normal-v3.json').read_text())
    payload['decision'] = decision
    payload['scan_status'] = 'FAILED' if decision == 'SCAN_FAILED' else 'SUCCESS'
    payload['reason_code'] = {'ALLOW':'ALL_APPLICABLE_CHECKS_PASSED', 'DENY':'RISK_DETECTED',
                              'REVIEW':'REVIEW_REQUIRED', 'SCAN_FAILED':'REQUIRED_SCAN_FAILED'}[decision]
    return payload


@pytest.mark.parametrize('decision', ['ALLOW','DENY','REVIEW','SCAN_FAILED'])
def test_gate_exit_decisions(monkeypatch,tmp_path,decision):
    monkeypatch.setattr(security.subprocess,'run',lambda *a,**kw:SimpleNamespace(
        returncode=security.CODES[decision],stdout=json.dumps(report(decision))))
    if decision=='ALLOW': assert security.require_allow(tmp_path)['decision']=='ALLOW'
    else:
        with pytest.raises(security.SecurityGateError,match=decision):security.require_allow(tmp_path)


@pytest.mark.parametrize('payload,code', [('SECRET',0), ('{}',0), ('[]',0),
    (json.dumps(report()),1), (json.dumps({**report(),'semgrep':{'decision':'REVIEW'}}),0)])
def test_invalid_reports_fail_closed(monkeypatch,tmp_path,payload,code):
    monkeypatch.setattr(security.subprocess,'run',lambda *a,**kw:SimpleNamespace(returncode=code,stdout=payload))
    with pytest.raises(security.SecurityGateError,match='SCAN_FAILED') as exc:security.require_allow(tmp_path)
    assert 'SECRET' not in str(exc.value)


def test_scan_before_ai_and_secret_filtering(monkeypatch,tmp_path):
    (tmp_path/'.env').write_text('SECRET')
    (tmp_path/'Dockerfile').write_text('FROM scratch\n')
    def deny(root):
        assert (root/'.env').read_text()=='SECRET'
        raise security.SecurityGateError('DENY')
    monkeypatch.setattr(security,'require_allow',deny)
    with pytest.raises(security.SecurityGateError):
        with prepared(tmp_path,SimpleNamespace(),llm=SimpleNamespace(suggest=lambda _:pytest.fail('AI called'))):
            pytest.fail('build reached')


def test_scan_and_build_share_copy(monkeypatch,tmp_path):
    source=tmp_path/'source'; source.mkdir()
    (source/'Dockerfile').write_text('FROM scratch\n')
    (source/'app.py').write_text('original')
    def allow(root):
        assert (root/'app.py').read_text()=='original'
        (source/'app.py').write_text('changed after scan')
        return report()
    monkeypatch.setattr(security,'require_allow',allow)
    with prepared(source,SimpleNamespace()) as (staged,plan):
        assert (staged/'app.py').read_text()=='original'
        assert plan['security_gate']['decision']=='ALLOW'


@pytest.mark.parametrize('decision',['DENY','REVIEW','SCAN_FAILED'])
def test_existing_dockerfile_deployment_cannot_bypass(monkeypatch,tmp_path,decision):
    (tmp_path/'Dockerfile').write_text('FROM scratch\n')
    monkeypatch.setattr('engine.analyzer.RepoAnalyzer.analyze',lambda *a:SimpleNamespace(evidence=[],database='postgres'))
    monkeypatch.setattr(security,'require_allow',lambda _:(_ for _ in ()).throw(security.SecurityGateError(decision)))
    runner=LocalRunner()
    runner.command=lambda *a,**kw:pytest.fail('Docker executed')
    with pytest.raises(DeploymentError,match=decision):runner.build(SimpleNamespace(repo=str(tmp_path)),'test')


def test_saved_plan_is_rescanned_before_docker(monkeypatch,tmp_path):
    builder=ImageBuilder(tmp_path,None,SimpleNamespace(command=lambda *a:pytest.fail('Docker executed')))
    root=tmp_path/'img_test';root.mkdir()
    builder.jobs['img_test']={'image':'test'}
    monkeypatch.setattr(security,'require_allow',lambda _:(_ for _ in ()).throw(security.SecurityGateError('DENY')))
    builder.run('img_test')
    assert builder.jobs['img_test']['status']=='failed'
    assert 'DENY' in builder.jobs['img_test']['error']
    builder.close()


def test_gate_timeout_redacted(monkeypatch,tmp_path):
    def timeout(*a,**kw):raise security.subprocess.TimeoutExpired('scanner SECRET',90)
    monkeypatch.setattr(security.subprocess,'run',timeout)
    with pytest.raises(security.SecurityGateError,match='SCAN_FAILED') as exc:security.require_allow(tmp_path)
    assert 'SECRET' not in str(exc.value)


def test_image_plan_api_rejects_before_llm(client,repository,monkeypatch):
    result=client.post('/api/projects',json={'repo':str(repository)})
    project=result.json()['id']
    client.app.state.llm.suggest=lambda _:pytest.fail('LLM called')
    monkeypatch.setattr(security,'require_allow',lambda _:(_ for _ in ()).throw(security.SecurityGateError('REVIEW')))
    response=client.post(f'/api/projects/{project}/image-plans',json={})
    assert response.status_code==400 and 'REVIEW' in response.json()['detail']


@pytest.mark.parametrize('stage',['create','select','resolve'])
def test_architecture_gated_at_each_boundary(monkeypatch,tmp_path,stage):
    from engine.architecture import ArchitecturePlanner, ArchitectureRequest, ArchitectureError
    root=tmp_path/'repo';root.mkdir()
    (root/'package.json').write_text('{"dependencies":{"express":"5"}}')
    planner=ArchitecturePlanner(tmp_path/'plans.db',LocalRunner(),None)
    project=SimpleNamespace(id='project',repo=str(root))
    options=ArchitectureRequest(peak_rps=5,availability='best_effort',traffic='steady',use_ai=False)
    monkeypatch.setattr(security,'require_allow',lambda _:report())
    plan=None
    if stage!='create':plan=planner.create(project,options)
    if stage=='resolve':planner.select(project,plan['id'],'small')
    monkeypatch.setattr(security,'require_allow',lambda _:(_ for _ in ()).throw(security.SecurityGateError('REVIEW')))
    with pytest.raises(ArchitectureError,match='REVIEW'):
        if stage=='create':planner.create(project,options)
        elif stage=='select':planner.select(project,plan['id'],'small')
        else:planner.resolve(project,plan['id'])


def no_compose_report():
    payload = report()
    payload['docker_compose'].update(decision='REVIEW', scan_status='NOT_APPLICABLE', files=[], errors=[])
    return payload


def test_compose_not_applicable_accepts_successful_required_scanners(monkeypatch, tmp_path):
    payload = no_compose_report()
    monkeypatch.setattr(security.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps(payload)))
    assert security.require_allow(tmp_path) == {'schema_version':'3.0', 'decision':'ALLOW', 'scan_status':'SUCCESS'}


@pytest.mark.parametrize('defect', ['compose_error', 'compose_files', 'compose_failed',
    'semgrep_na', 'gitleaks_na', 'missing_tool', 'missing_field', 'coverage_gap'])
def test_no_compose_never_weakens_required_checks(monkeypatch, tmp_path, defect):
    payload = no_compose_report()
    if defect == 'compose_error': payload['docker_compose']['errors'] = ['ACCESS_DENIED']
    elif defect == 'compose_files': payload['docker_compose']['files'] = report()['docker_compose']['files']
    elif defect == 'compose_failed': payload['docker_compose']['scan_status'] = 'FAILED'
    elif defect.endswith('_na'):
        payload[defect[:-3]].update(decision='REVIEW', scan_status='NOT_APPLICABLE', scanned_files=0)
    elif defect == 'missing_tool': del payload['gitleaks']
    elif defect == 'missing_field': del payload['semgrep']['scanned_files']
    elif defect == 'coverage_gap': payload['semgrep']['unsupported_files'] = 1
    monkeypatch.setattr(security.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps(payload)))
    with pytest.raises(security.SecurityGateError, match='SCAN_FAILED'): security.require_allow(tmp_path)
