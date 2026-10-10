"""Engine/Azure boundary tests: no Azure subscription, network, Docker or costs."""
import json
from pathlib import Path
import httpx
import pytest
from engine.deployments import DeploymentError
from engine.azure_runner import AzureRunner
from test_comparisons import project

SUBSCRIPTION = '004f9d0c-fa50-4589-acdc-f675eeba7cc6'
ACR = 'sdacrtest.azurecr.io/shakedown-board'
URL = 'https://sd-app.test.koreacentral.azurecontainerapps.io'
DIGEST = 'sha256:' + 'a' * 64
ECR_IMAGE = '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/board@' + DIGEST


@pytest.fixture
def configured(monkeypatch, tmp_path, project):
    config = {'subscriptionId': SUBSCRIPTION, 'tenantId': 'b0e5e1fb-eace-41f3-8333-4d1354340445', 'resourceGroup': 'rg-shakedown-board',
              'projectId': project.id, 'containerApp': 'sd-app', 'repositoryUri': ACR, 'publicUrl': URL,
              'dbHost': 'sd-pg.postgres.database.azure.com', 'dbName': project.analysis.database_name or 'board_db',
              'dbUsername': 'app', 'dbPasswordSecretUri': 'https://sd-kv.vault.azure.net/secrets/db-password', 'port': project.analysis.port}
    path = tmp_path / 'azure.json'; path.write_text(json.dumps(config))
    monkeypatch.setenv('AZURE_ADAPTER_CONFIG', str(path))
    monkeypatch.setenv('HACKATHON_PUBLISH_PROFILE', 'test-publisher')
    monkeypatch.setenv('DOCKER_HOST', 'unix:///tmp/docker.sock'); monkeypatch.delenv('DOCKER_CONTEXT', raising=False)
    return config, path


class Shell:
    """Records az/aws/docker invocations and answers them like the real CLIs would."""
    def __init__(self, acr_digest=DIGEST, subscription=SUBSCRIPTION):
        self.calls = []; self.acr_digest = acr_digest; self.subscription = subscription
    def capture(self, args, input=None, env=None):
        self.calls.append((list(args), {'input': input, 'env': env}))
        if args[:3] == ['az', 'account', 'show']: return self.subscription
        if '--expose-token' in args: return 'ACR_TOKEN_DO_NOT_LOG'
        if 'get-login-password' in args: return 'ECR_TOKEN_DO_NOT_LOG'
        if args[:4] == ['az', 'acr', 'repository', 'show']: return self.acr_digest
        return ''
    def command(self, args, timeout, env=None):
        self.calls.append((list(args), {'env': env}))


def runner_with(monkeypatch, shell):
    runner = AzureRunner()
    monkeypatch.setattr(runner, 'capture', shell.capture)
    monkeypatch.setattr(runner, 'command', shell.command)
    # ECR login goes through AwsRunner; route it to the same fake shell.
    monkeypatch.setattr('engine.aws_runner.AwsRunner.capture', staticmethod(shell.capture))
    return runner


def test_missing_azure_configuration_is_clear(monkeypatch):
    monkeypatch.delenv('AZURE_ADAPTER_CONFIG', raising=False)
    with pytest.raises(DeploymentError, match='AZURE_ADAPTER_CONFIG'): AzureRunner().config()


def test_valid_config_is_returned(configured):
    assert AzureRunner().config()['repositoryUri'] == ACR


@pytest.mark.parametrize('patch', [
    {'subscriptionId': 'not-a-guid'}, {'tenantId': '1234'},
    {'repositoryUri': 'docker.io/shakedown-board'}, {'repositoryUri': 'sdacrtest.azurecr.io'},
    {'publicUrl': 'http://sd-app.test.koreacentral.azurecontainerapps.io'}, {'publicUrl': 'https://evil.example'},
    {'publicUrl': 'http://board.ap-northeast-2.elb.amazonaws.com'},
])
def test_config_rejects_foreign_or_malformed_resources(configured, patch):
    config, path = configured; config.update(patch); path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError, match='Invalid Azure'): AzureRunner().config()


@pytest.mark.parametrize('key', ['projectId', 'port', 'dbName'])
def test_config_requires_project_binding(configured, key):
    config, path = configured; del config[key]; path.write_text(json.dumps(config))
    with pytest.raises(DeploymentError, match='Invalid Azure'): AzureRunner().config()


def test_subscription_mismatch_fails_before_adapter(monkeypatch, configured, project):
    shell = Shell(subscription='11111111-1111-1111-1111-111111111111'); runner = runner_with(monkeypatch, shell)
    monkeypatch.setattr(runner, 'call', lambda *a, **k: pytest.fail('adapter must not be called'))
    with pytest.raises(DeploymentError, match='subscription'): runner.preflight(project)


def test_project_mismatch_before_any_azure_call(monkeypatch, configured, project):
    config, path = configured; config['projectId'] = 'prj_other'; path.write_text(json.dumps(config))
    shell = Shell(); runner = runner_with(monkeypatch, shell)
    with pytest.raises(DeploymentError, match='projectId'): runner.preflight(project)
    assert shell.calls == []


@pytest.mark.parametrize('mode,engine,ok', [('mysql', 'mysql', True), ('mysql', 'postgres', False), ('mongodb', 'mysql', False), ('external', 'mysql', True), ('none', 'mongodb', True)])
def test_preflight_matches_runtime_database_engine_to_the_stack(monkeypatch, tmp_path, configured, project, mode, engine, ok):
    config, path = configured; config = {**config, 'dbEngine': engine}; path.write_text(json.dumps(config))
    project.runtime = {'version': 'http-runtime.v1', 'port': config['port'], 'health_path': '/', 'env': {}, 'secret_refs': {},
                       'database': {'mode': mode, 'name': config['dbName'], 'bindings': {}}, 'init_command': []}
    runner = runner_with(monkeypatch, Shell(subscription=SUBSCRIPTION))
    monkeypatch.setattr(runner, 'call', lambda method, path, body=None: {'ok': True, 'target': 'azure'})
    if ok: runner.preflight(project)
    else:
        with pytest.raises(DeploymentError, match=f'needs {mode}'): runner.preflight(project)


@pytest.mark.parametrize('health,ok', [({'ok': True, 'target': 'azure'}, True), ({'ok': True, 'target': 'aws'}, False), (None, False)])
def test_preflight_requires_azure_adapter_health(monkeypatch, configured, project, health, ok):
    runner = runner_with(monkeypatch, Shell(subscription=SUBSCRIPTION.upper()))
    monkeypatch.setattr(runner, 'call', lambda method, path, body=None: health)
    if ok: runner.preflight(project)
    else:
        with pytest.raises(DeploymentError, match='9104'): runner.preflight(project)


def test_publish_copies_ecr_digest_into_acr_and_keeps_tokens_off_argv(monkeypatch, configured):
    shell = Shell(); runner = runner_with(monkeypatch, shell)
    assert runner.publish(ECR_IMAGE, 'dep_test') == ACR + '@' + DIGEST
    argv = [' '.join(args) for args, _ in shell.calls]
    assert not any('TOKEN_DO_NOT_LOG' in a for a in argv)
    logins = [kw for args, kw in shell.calls if args[:2] == ['docker', 'login']]
    assert [kw['input'] for kw in logins] == [b'ACR_TOKEN_DO_NOT_LOG', b'ECR_TOKEN_DO_NOT_LOG']
    copy = next(args for args, _ in shell.calls if args[:3] == ['docker', 'buildx', 'imagetools'])
    assert copy == ['docker', 'buildx', 'imagetools', 'create', '-t', ACR + ':dep_test', ECR_IMAGE]
    assert not Path(logins[0]['env']['DOCKER_CONFIG']).exists()


def test_publish_refuses_a_changed_digest(monkeypatch, configured):
    runner = runner_with(monkeypatch, Shell(acr_digest='sha256:' + 'b' * 64))
    with pytest.raises(DeploymentError, match='digest differs'): runner.publish(ECR_IMAGE, 'dep_test')


@pytest.mark.parametrize('source', [ECR_IMAGE.split('@')[0] + ':latest', 'evil.example/board@' + DIGEST, ACR + '@' + DIGEST])
def test_publish_requires_a_pinned_ecr_source_before_any_command(monkeypatch, configured, source):
    shell = Shell(); runner = runner_with(monkeypatch, shell)
    with pytest.raises(DeploymentError, match='pinned'): runner.publish(source, 'dep_test')
    assert shell.calls == []


def test_build_publish_builds_amd64_and_returns_acr_digest(monkeypatch, configured, project):
    shell = Shell(); runner = runner_with(monkeypatch, shell)
    monkeypatch.setattr(runner, 'preflight', lambda p: runner.config())
    monkeypatch.setattr(runner, 'build', lambda p, image, platform: p.analysis if platform == 'linux/amd64' and image == ACR + ':dep_test' else None)
    analysis, image = runner.build_publish(project, 'dep_test')
    assert image == ACR + '@' + DIGEST and analysis == project.analysis
    assert any(args == ['docker', 'push', ACR + ':dep_test'] for args, _ in shell.calls)
    assert any(args[:2] == ['docker', 'pull'] and image in args for args, _ in shell.calls)
    assert not any('TOKEN_DO_NOT_LOG' in ' '.join(args) for args, _ in shell.calls)


def test_valid_url_matches_configured_public_url_only(configured):
    runner = AzureRunner()
    assert runner.valid_url(URL) and runner.valid_url(URL + '/')
    assert not runner.valid_url('https://evil.example') and not runner.valid_url(URL.replace('https', 'http'))


def test_call_errors_point_at_azure_adapter(monkeypatch):
    def refuse(self, method, url, **kwargs): raise httpx.ConnectError('refused')
    monkeypatch.setattr(httpx.Client, 'request', refuse)
    with pytest.raises(DeploymentError, match='Azure Target request failed.*9104'): AzureRunner().call('GET', '/health')
