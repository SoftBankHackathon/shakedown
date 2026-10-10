"""Engine/GCP runner boundary tests: no GCP project, network, Docker or costs."""
import json
from pathlib import Path
import httpx
import pytest
from engine import gcp_runner
from engine.deployments import DeploymentError
from engine.gcp_runner import GcpRunner
from test_comparisons import project

PREFIX = 'asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/'
DIGEST = PREFIX + 'kty-board@sha256:' + 'a' * 64
URL = 'https://shakedown-board-700410260240.asia-northeast3.run.app'

@pytest.fixture
def configured(monkeypatch, tmp_path, project):
    # Same keys as infra/gcp/.data/config.json written by provision.sh.
    config = {'gcpProject': 'shakedown-511106', 'gcpProjectNumber': '700410260240', 'region': 'asia-northeast3',
              'projectId': project.id, 'serviceName': 'shakedown-board', 'jobName': 'shakedown-board-schema',
              'imagePrefixes': [PREFIX], 'network': 'default', 'subnetwork': 'default', 'dbHost': '10.20.0.3',
              'dbName': project.analysis.database_name or 'board_db', 'dbUsername': 'board',
              'dbPasswordSecret': 'shakedown-db-password', 'port': project.analysis.port, 'memory': '1Gi', 'cpu': '1'}
    path = tmp_path / 'gcp.json'; path.write_text(json.dumps(config))
    monkeypatch.setenv('GCP_ADAPTER_CONFIG', str(path))
    return config, path

def test_missing_gcp_configuration_is_clear(monkeypatch):
    monkeypatch.delenv('GCP_ADAPTER_CONFIG', raising=False)
    with pytest.raises(DeploymentError, match='GCP_ADAPTER_CONFIG'): GcpRunner().config()

@pytest.mark.parametrize('patch', [{'region': 'us-central1'}, {'gcpProject': 'Bad_Project'}, {'gcpProjectNumber': 'abc'},
                                   {'serviceName': 'Bad_Name'}, {'imagePrefixes': []}, {'imagePrefixes': ['docker.io/library/']},
                                   {'imagePrefixes': ['asia-northeast3-docker.pkg.dev/other-project/shakedown/']}])
def test_config_rejects_mismatched_resources(configured, patch):
    config, path = configured; config.update(patch); path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError, match='Invalid GCP'): GcpRunner().config()

@pytest.mark.parametrize('key', ['projectId', 'port', 'dbName'])
def test_config_requires_engine_binding_keys(configured, key):
    config, path = configured; del config[key]; path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError, match='Invalid GCP'): GcpRunner().config()

def test_valid_url_is_only_the_configured_service(configured):
    runner = GcpRunner()
    assert runner.valid_url(URL) and runner.valid_url(URL + '/')
    assert not runner.valid_url('https://evil.run.app') and not runner.valid_url(URL.replace('https', 'http'))

def test_call_uses_fixed_loopback_and_hides_errors(monkeypatch):
    seen, real = [], httpx.Client
    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(500 if request.method == 'DELETE' else 200, json={'ok': True, 'target': 'gcp'})
    monkeypatch.setattr(gcp_runner.httpx, 'Client', lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    assert GcpRunner().call('GET', '/health') == {'ok': True, 'target': 'gcp'}
    with pytest.raises(DeploymentError, match='GCP Target request failed'): GcpRunner().call('DELETE', '/deployments/dep_a')
    assert seen == ['http://127.0.0.1:9103/health', 'http://127.0.0.1:9103/deployments/dep_a']


def test_project_mismatch_before_any_gcp_call(monkeypatch, configured, project):
    config, path = configured; config['projectId'] = 'prj_other'; path.write_text(json.dumps(config))
    runner, calls = GcpRunner(), []
    monkeypatch.setattr(runner, 'capture', lambda *a, **k: calls.append(a))
    monkeypatch.setattr(runner, 'call', lambda *a, **k: calls.append(a))
    with pytest.raises(DeploymentError, match='projectId') as error: runner.preflight(project)
    # 어댑터 상태 DB는 projectId에 묶여 있어, 같은 DB로 다시 띄우면 기동을 거부한다. 새 DB 파일을 쓰라고 알려야 한다.
    assert 'GCP_ADAPTER_DB' in str(error.value)
    assert calls == []

def test_port_or_database_mismatch_is_rejected(configured, project):
    config, path = configured; config['dbName'] = 'other_db'; path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError, match='port/database'): GcpRunner().preflight(project)

def saved_runtime(project, mode, name='board_db', port=3000):
    # 실행 설정(runtime)을 저장한 프로젝트는 database·secret_refs 대신 runtime을 보낸다.
    return project.model_copy(update={'runtime': {'version': 'http-runtime.v1', 'port': port, 'health_path': '/healthz', 'env': {}, 'secret_refs': {},
                                                  'database': {'mode': mode, 'name': name, 'bindings': {}}, 'init_command': []}})

@pytest.mark.parametrize('mode', ['none', 'postgres'])
def test_saved_runtime_with_no_db_or_postgres_passes_preflight_on_any_port(monkeypatch, configured, project, mode):
    runner = GcpRunner()
    monkeypatch.setattr(runner, 'capture', lambda args, **k: 'shakedown-511106')
    monkeypatch.setattr(runner, 'call', lambda method, path, body=None: {'ok': True, 'target': 'gcp'})
    # 옛 방식과 달리 포트는 설정과 같지 않아도 된다(Cloud Run은 리비전마다 containerPort를 정한다). 분석 결과의 포트·DB 이름은 보지 않는다.
    saved = saved_runtime(project, mode, port=3000)
    saved = saved.model_copy(update={'analysis': saved.analysis.model_copy(update={'port': 1234, 'database_name': 'other_db'})})
    assert runner.preflight(saved) is None

@pytest.mark.parametrize('mode', ['mysql', 'mongodb', 'external'])
def test_saved_runtime_with_another_database_is_rejected_before_any_gcp_call(monkeypatch, configured, project, mode):
    runner, calls = GcpRunner(), []
    monkeypatch.setattr(runner, 'capture', lambda *a, **k: calls.append(a))
    monkeypatch.setattr(runner, 'call', lambda *a, **k: calls.append(a))
    with pytest.raises(DeploymentError, match='none and postgres only'): runner.preflight(saved_runtime(project, mode))
    assert calls == []

def test_saved_runtime_postgres_must_use_the_prepared_database_name(monkeypatch, configured, project):
    runner, calls = GcpRunner(), []
    monkeypatch.setattr(runner, 'capture', lambda *a, **k: calls.append(a))
    monkeypatch.setattr(runner, 'call', lambda *a, **k: calls.append(a))
    with pytest.raises(DeploymentError, match='dbName'): runner.preflight(saved_runtime(project, 'postgres', name='other_db'))
    assert calls == []

def test_gcloud_project_mismatch_fails_before_adapter(monkeypatch, configured, project):
    runner, calls = GcpRunner(), []
    monkeypatch.setattr(runner, 'capture', lambda args, **k: calls.append(args) or 'other-project')
    monkeypatch.setattr(runner, 'call', lambda *a, **k: pytest.fail('adapter must not be called'))
    with pytest.raises(DeploymentError, match='gcloud'): runner.preflight(project)
    assert calls == [['gcloud', 'config', 'get', 'project']]

def test_missing_gcloud_on_the_engine_is_named_in_preflight(monkeypatch, configured, project):
    # 엔진을 gcloud가 PATH에 없는 셸에서 띄우면 빌드 전 사전 확인에서 멈춘다. 오류가 "push 실패"가 아니라 엔진의 gcloud를 가리켜야 한다.
    runner = GcpRunner()
    def missing(args, **kwargs): raise DeploymentError('GCP publishing command failed; check gcloud login, Artifact Registry permissions and Docker. No credentials were logged.')
    monkeypatch.setattr(runner, 'capture', missing)
    monkeypatch.setattr(runner, 'call', lambda *a, **k: pytest.fail('adapter must not be called'))
    with pytest.raises(DeploymentError, match='gcloud CLI is not available to the engine'): runner.preflight(project)

@pytest.mark.parametrize('health', [None, {'ok': True, 'target': 'aws'}, {'ok': False, 'target': 'gcp'}])
def test_adapter_must_be_the_gcp_target(monkeypatch, configured, project, health):
    runner = GcpRunner()
    monkeypatch.setattr(runner, 'capture', lambda args, **k: 'shakedown-511106')
    monkeypatch.setattr(runner, 'call', lambda method, path, body=None: health)
    with pytest.raises(DeploymentError, match='9103'): runner.preflight(project)

def test_preflight_passes_when_project_gcloud_and_adapter_match(monkeypatch, configured, project):
    runner = GcpRunner()
    monkeypatch.setattr(runner, 'capture', lambda args, **k: 'shakedown-511106')
    monkeypatch.setattr(runner, 'call', lambda method, path, body=None: {'ok': True, 'target': 'gcp'})
    assert runner.preflight(project) is None

def test_failed_command_hides_its_output(monkeypatch):
    def fail(args, **kwargs): raise gcp_runner.subprocess.CalledProcessError(1, args, output=b'TOKEN_DO_NOT_LOG')
    monkeypatch.setattr(gcp_runner.subprocess, 'run', fail)
    with pytest.raises(DeploymentError) as error: GcpRunner.capture(['gcloud', 'auth', 'print-access-token'])
    assert 'TOKEN_DO_NOT_LOG' not in str(error.value) and 'No credentials were logged' in str(error.value)


def fake_publish(monkeypatch, runner, digest='sha256:' + 'a' * 64):
    """Replace preflight, Docker and gcloud with recorders. Returns the ordered list of (args, kwargs)."""
    calls = []
    monkeypatch.setattr(runner, 'preflight', lambda p: calls.append((['preflight'], {})))
    monkeypatch.setattr(runner, 'build', lambda p, image, platform=None: calls.append((['build', image, platform], {})) or p.analysis)
    def capture(args, **kwargs):
        calls.append((args, kwargs))
        if args[:3] == ['gcloud', 'auth', 'print-access-token']: return 'TOKEN_DO_NOT_LOG'
        if 'describe' in args: return digest
        if 'context' in args: return 'unix:///tmp/docker.sock'
        return ''
    monkeypatch.setattr(runner, 'capture', capture)
    monkeypatch.setattr(runner, 'command', lambda args, timeout, env=None: calls.append((args, {'env': env})))
    return calls

def test_publish_builds_amd64_pushes_then_pins_the_registry_digest(monkeypatch, configured, project):
    runner = GcpRunner(); calls = fake_publish(monkeypatch, runner)
    analysis, image = runner.build_publish(project, 'dep_test')
    assert analysis == project.analysis and image == DIGEST
    tag = PREFIX + 'kty-board:dep_test'
    steps = [args for args, _ in calls]
    assert steps[:2] == [['preflight'], ['build', tag, 'linux/amd64']]
    login = steps.index(['docker', 'login', '--username', 'oauth2accesstoken', '--password-stdin', 'https://asia-northeast3-docker.pkg.dev'])
    push = steps.index(['docker', 'push', tag])
    describe = steps.index(['gcloud', 'artifacts', 'docker', 'images', 'describe', tag, '--format=value(image_summary.digest)'])
    pull = steps.index(['docker', 'pull', '--platform', 'linux/amd64', DIGEST])
    assert login < push < describe < pull

def test_publish_keeps_the_token_on_stdin_in_a_temporary_docker_config(monkeypatch, configured, project):
    runner = GcpRunner(); calls = fake_publish(monkeypatch, runner)
    runner.build_publish(project, 'dep_test')
    assert not any('TOKEN_DO_NOT_LOG' in ' '.join(args) for args, _ in calls)
    login = next(kw for args, kw in calls if 'login' in args)
    push = next(kw for args, kw in calls if 'push' in args)
    assert login['input'] == b'TOKEN_DO_NOT_LOG' and push['env']['DOCKER_CONFIG'] == login['env']['DOCKER_CONFIG']
    assert 'DOCKER_CONTEXT' not in push['env'] and not Path(login['env']['DOCKER_CONFIG']).exists()

@pytest.mark.parametrize('digest', ['', 'latest', 'sha256:abc', 'sha256:' + 'A' * 64])
def test_publish_rejects_an_invalid_digest_before_pull(monkeypatch, configured, project, digest):
    runner = GcpRunner(); calls = fake_publish(monkeypatch, runner, digest)
    with pytest.raises(DeploymentError, match='digest'): runner.build_publish(project, 'dep_test')
    assert not any('pull' in args for args, _ in calls)

def test_publish_rejects_a_checkout_that_no_longer_matches_the_legacy_port(monkeypatch, configured, project):
    runner = GcpRunner(); calls = fake_publish(monkeypatch, runner)
    monkeypatch.setattr(runner, 'build', lambda p, image, platform=None: p.analysis.model_copy(update={'port': p.analysis.port + 1}))
    with pytest.raises(DeploymentError, match='no longer matches'): runner.build_publish(project, 'dep_test')
    assert not any('push' in args for args, _ in calls)

def test_publish_with_a_saved_runtime_skips_the_legacy_port_and_database_check(monkeypatch, configured, project):
    # 엔진 build는 runtime이면 analysis.port를 runtime.port로 바꾼다. DB 이름은 preflight가 runtime 값으로 이미 확인했다.
    runner = GcpRunner(); fake_publish(monkeypatch, runner)
    monkeypatch.setattr(runner, 'build', lambda p, image, platform=None: p.analysis.model_copy(update={'port': 3000, 'database_name': None}))
    analysis, image = runner.build_publish(saved_runtime(project, 'none'), 'dep_test')
    assert analysis.port == 3000 and image == DIGEST
