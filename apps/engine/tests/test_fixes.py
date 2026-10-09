"""차단 뒤 수정 적용 흐름 테스트: 실제 GCP·AWS·Docker·네트워크 없이 가짜 어댑터와 가짜 시운전만 쓴다."""
from engine.deployments import DeploymentStore, DeployRequest, CompareRequest, Endpoint
from test_comparisons import Runner, Shakedown, wait, project
from test_gcp_deployments import Gcp
from test_aws_deployments import Aws


def hints_sent(sd):
    return [body['hints'] for method, _, body in sd.calls if method == 'POST']


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
