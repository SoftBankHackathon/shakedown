"""Engine/GCP runner boundary tests: no GCP project, network, Docker or costs."""
import json
import os
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


ECR_IMAGE = '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/board@sha256:' + 'a' * 64
ACR = 'sdacrtest.azurecr.io/shakedown-board'
ACR_IMAGE = ACR + '@sha256:' + 'a' * 64

@pytest.fixture
def sources(monkeypatch, tmp_path, configured, project):
    """ECR(AWS 발행 프로필)와 ACR(Azure 어댑터 설정)에서 복사할 수 있는 엔진 환경."""
    azure = {'subscriptionId': '004f9d0c-fa50-4589-acdc-f675eeba7cc6', 'tenantId': 'b0e5e1fb-eace-41f3-8333-4d1354340445',
             'projectId': project.id, 'repositoryUri': ACR, 'publicUrl': 'https://sd-app.test.koreacentral.azurecontainerapps.io',
             'dbName': project.analysis.database_name or 'board_db', 'port': project.analysis.port}
    path = tmp_path / 'azure.json'; path.write_text(json.dumps(azure))
    monkeypatch.setenv('AZURE_ADAPTER_CONFIG', str(path))
    aws = {'accountId': '123456789012', 'region': 'ap-northeast-2', 'repository': 'board', 'repositoryUri': ECR_IMAGE.split('@')[0],
           'publicUrl': 'http://board.ap-northeast-2.elb.amazonaws.com', 'projectId': project.id, 'port': project.analysis.port}
    path = tmp_path / 'aws.json'; path.write_text(json.dumps(aws))
    monkeypatch.setenv('AWS_ADAPTER_CONFIG', str(path))
    monkeypatch.setenv('HACKATHON_PUBLISH_PROFILE', 'test-publisher')
    monkeypatch.setenv('DOCKER_HOST', 'unix:///tmp/docker.sock'); monkeypatch.delenv('DOCKER_CONTEXT', raising=False)
    # 사용자 Docker 설정: Homebrew buildx처럼 따로 등록한 플러그인 폴더와, 임시 설정으로 옮기면 안 되는 로그인 기록.
    user = tmp_path / 'user-docker'; user.mkdir()
    (user / 'config.json').write_text(json.dumps({'auths': {'ghcr.io': {'auth': 'USER_LOGIN_DO_NOT_COPY'}},
                                                  'cliPluginsExtraDirs': ['/opt/homebrew/lib/docker/cli-plugins']}))
    monkeypatch.setenv('DOCKER_CONFIG', str(user))

class Shell:
    """gcloud·aws·az·docker 호출을 기록하고 실제 CLI처럼 답한다. 토큰은 표준입력으로만 오가야 한다."""
    def __init__(self, copied='sha256:' + 'a' * 64, broken=None): self.calls = []; self.copied = copied; self.broken = broken
    def capture(self, args, input=None, env=None):
        self.calls.append((list(args), {'input': input, 'env': env}))
        if self.broken and self.broken in args: raise DeploymentError('AWS publishing command failed; check the named profile, permissions and Docker. No credentials were logged.')
        if args[:3] == ['gcloud', 'auth', 'print-access-token']: return 'GAR_TOKEN_DO_NOT_LOG'
        if 'get-login-password' in args: return 'ECR_TOKEN_DO_NOT_LOG'
        if '--expose-token' in args: return 'ACR_TOKEN_DO_NOT_LOG'
        if 'describe' in args: return self.copied
        return ''
    def command(self, args, timeout, env=None):
        self.calls.append((list(args), {'env': env}))
        # 임시 Docker 설정은 끝나면 지워지므로, buildx를 부르는 순간의 설정 파일을 적어 둔다.
        if args[:2] == ['docker', 'buildx']: self.config = json.loads((Path(env['DOCKER_CONFIG']) / 'config.json').read_text())
        if self.broken and self.broken in args: raise DeploymentError('docker failed or timed out; inspect the local build environment.')

def publisher(monkeypatch, shell):
    runner = GcpRunner()
    monkeypatch.setattr(runner, 'capture', shell.capture)
    monkeypatch.setattr(runner, 'command', shell.command)
    # ECR·ACR 로그인은 AwsRunner·AzureRunner를 거친다. 같은 가짜 셸로 보낸다.
    monkeypatch.setattr('engine.aws_runner.AwsRunner.capture', staticmethod(shell.capture))
    monkeypatch.setattr('engine.azure_runner.AzureRunner.capture', staticmethod(shell.capture))
    return runner

@pytest.mark.parametrize('source, registry, token', [
    (ECR_IMAGE, '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com', b'ECR_TOKEN_DO_NOT_LOG'),
    (ACR_IMAGE, 'sdacrtest.azurecr.io', b'ACR_TOKEN_DO_NOT_LOG')])
def test_publish_copies_the_source_digest_into_artifact_registry(monkeypatch, sources, source, registry, token):
    shell = Shell(); runner = publisher(monkeypatch, shell)
    assert runner.publish(source, 'dep_test') == DIGEST
    tag = PREFIX + 'kty-board:dep_test'
    steps = [args for args, _ in shell.calls]
    logins = [(args[-1], kw['input']) for args, kw in shell.calls if args[:2] == ['docker', 'login']]
    assert logins == [('https://asia-northeast3-docker.pkg.dev', b'GAR_TOKEN_DO_NOT_LOG'), (registry, token)]
    # --prefer-index 기본값(true)은 단일 manifest를 새 index로 감싸 digest를 바꾼다. 그대로 복사하게 끈다.
    copy = steps.index(['docker', 'buildx', 'imagetools', 'create', '--prefer-index=false', '-t', tag, source])
    # 빈 임시 설정에서는 Docker Desktop의 buildx(사용자 설정 폴더의 cli-plugins)를 못 찾는다.
    assert shell.config['cliPluginsExtraDirs'] == [str(Path(os.environ['DOCKER_CONFIG']) / 'cli-plugins'), '/opt/homebrew/lib/docker/cli-plugins']
    assert 'USER_LOGIN_DO_NOT_COPY' not in json.dumps(shell.config)
    # auths가 비어 있으면 Docker CLI가 OS 키체인(osxkeychain)을 기본 저장소로 골라 토큰이 임시 폴더 밖에 남는다.
    assert shell.config['auths'] and 'credsStore' not in shell.config and 'credHelpers' not in shell.config
    assert copy < steps.index(['gcloud', 'artifacts', 'docker', 'images', 'describe', tag, '--format=value(image_summary.digest)'])
    # 다시 빌드·push하지 않고 레지스트리끼리 manifest만 복사한다(digest가 그대로 남는다).
    assert not any(args[:2] in (['docker', 'push'], ['docker', 'pull'], ['docker', 'build']) for args in steps)
    assert not any('TOKEN_DO_NOT_LOG' in ' '.join(args) for args in steps)
    configs = {kw['env']['DOCKER_CONFIG'] for args, kw in shell.calls if args[0] == 'docker'}
    assert len(configs) == 1 and not Path(configs.pop()).exists()

@pytest.mark.parametrize('source', [
    ECR_IMAGE.split('@')[0] + ':latest',                                 # 태그는 가리키는 이미지가 바뀔 수 있다
    ECR_IMAGE.replace('ap-northeast-2', 'us-east-1'),                     # 다른 리전 ECR
    ECR_IMAGE.replace('123456789012', '210987654321'),                   # 설정에 없는 AWS 계정
    ECR_IMAGE.replace('/board@', '/other-board@'),                       # 같은 ECR의 다른 저장소
    'evil.example/board@sha256:' + 'a' * 64,                             # 모르는 레지스트리
    DIGEST,                                                              # Artifact Registry 자신
    'otheracr.azurecr.io/shakedown-board@sha256:' + 'a' * 64,            # 설정에 없는 ACR
    'sdacrtest.azurecr.io/other-board@sha256:' + 'a' * 64,               # 같은 ACR의 다른 저장소
])
def test_publish_rejects_unpinned_or_unknown_sources_before_any_command(monkeypatch, sources, source):
    shell = Shell(); runner = publisher(monkeypatch, shell)
    with pytest.raises(DeploymentError, match='pinned'): runner.publish(source, 'dep_test')
    assert shell.calls == []

@pytest.mark.parametrize('copied, error', [('sha256:' + 'b' * 64, 'Artifact Registry image digest differs'), ('', 'valid image digest')])
def test_publish_refuses_a_different_or_missing_digest_in_artifact_registry(monkeypatch, sources, copied, error):
    runner = publisher(monkeypatch, Shell(copied))
    with pytest.raises(DeploymentError, match=error): runner.publish(ECR_IMAGE, 'dep_test')

@pytest.mark.parametrize('broken', ['get-login-password', 'imagetools'])
def test_publish_failure_names_the_gcp_copy_step(monkeypatch, sources, broken):
    # AWS 빌드·push는 이미 끝났다. ECR 로그인이나 복사가 실패하면 'AWS 발행'·'로컬 빌드 환경'이 아니라 GCP 복사 단계를 가리켜야 한다.
    runner = publisher(monkeypatch, Shell(broken=broken))
    with pytest.raises(DeploymentError, match='Copying the image into Artifact Registry failed') as error: runner.publish(ECR_IMAGE, 'dep_test')
    assert 'local build environment' not in str(error.value) and 'AWS publishing' not in str(error.value)

@pytest.mark.parametrize('profile', [None, 'default'])
def test_publish_from_ecr_needs_the_named_publish_profile(monkeypatch, sources, profile):
    if profile: monkeypatch.setenv('HACKATHON_PUBLISH_PROFILE', profile)
    else: monkeypatch.delenv('HACKATHON_PUBLISH_PROFILE')
    shell = Shell(); runner = publisher(monkeypatch, shell)
    with pytest.raises(DeploymentError, match='HACKATHON_PUBLISH_PROFILE'): runner.publish(ECR_IMAGE, 'dep_test')
    assert shell.calls == []

def test_publish_checks_the_gcp_configuration_first(monkeypatch, sources):
    monkeypatch.delenv('GCP_ADAPTER_CONFIG')
    shell = Shell(); runner = publisher(monkeypatch, shell)
    with pytest.raises(DeploymentError, match='GCP_ADAPTER_CONFIG'): runner.publish(ECR_IMAGE, 'dep_test')
    assert shell.calls == []

@pytest.mark.parametrize('extra', ['/opt/homebrew/lib/docker/cli-plugins', None, 7])
def test_docker_env_ignores_a_malformed_user_plugin_setting(monkeypatch, tmp_path, extra):
    # Docker는 cliPluginsExtraDirs를 문자열 목록으로 읽는다. 목록이 아니면 글자 하나하나를 폴더로 넘기지 않고 기본 폴더만 쓴다.
    user = tmp_path / 'user-docker'; user.mkdir(); (user / 'config.json').write_text(json.dumps({'cliPluginsExtraDirs': extra}))
    monkeypatch.setenv('DOCKER_CONFIG', str(user)); monkeypatch.setenv('DOCKER_HOST', 'unix:///tmp/docker.sock')
    auth = tmp_path / 'auth'; auth.mkdir()
    GcpRunner().docker_env(str(auth))
    assert json.loads((auth / 'config.json').read_text())['cliPluginsExtraDirs'] == [str(user / 'cli-plugins')]
