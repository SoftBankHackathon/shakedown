"""Azure adapter boundary and digest-preserving ACR publishing; credentials stay server-side."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import httpx

from engine.aws_runner import AwsRunner
from engine.deployments import DeploymentError, LocalRunner

GUID = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
DIGEST = r'sha256:[a-f0-9]{64}'
ECR = r'\d{12}\.dkr\.ecr\.ap-northeast-2\.amazonaws\.com'
# ACR access tokens are used with this fixed user name (az acr login --expose-token).
ACR_TOKEN_USER = '00000000-0000-0000-0000-000000000000'


class AzureRunner(LocalRunner):
    def __init__(self):
        self.base = 'http://127.0.0.1:9104'

    def config(self):
        path = os.environ.get('AZURE_ADAPTER_CONFIG')
        if not path:
            raise DeploymentError('Azure requires AZURE_ADAPTER_CONFIG on the engine. Prepare the Container Apps stack and schema first; see infra/azure/README.md.')
        try:
            config = json.loads(Path(path).read_text())
            if (not re.fullmatch(GUID, config['subscriptionId']) or not re.fullmatch(GUID, config['tenantId'])
                    or not re.fullmatch(r'[a-z0-9]{5,50}\.azurecr\.io/[a-z0-9][a-z0-9/_.-]*', config['repositoryUri'])
                    or not re.fullmatch(r'https://[a-z0-9.-]+\.azurecontainerapps\.io/?', config['publicUrl'])):
                raise ValueError()
            for key in ('projectId', 'port', 'dbName'): config[key]
            return config
        except (OSError, ValueError, KeyError, TypeError):
            raise DeploymentError('Invalid Azure adapter configuration; regenerate it from Bicep outputs.') from None

    @staticmethod
    def capture(args, input=None, env=None):
        try:
            result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=120, check=True, env=env)
            return result.stdout.decode().strip()
        except (OSError, subprocess.SubprocessError, UnicodeError):
            raise DeploymentError('Azure publishing command failed; check az login, ACR permissions and Docker. No credentials were logged.') from None

    @staticmethod
    def registry(config):
        """(server, ACR name, repository) from '<name>.azurecr.io/<repo>'."""
        server, repo = config['repositoryUri'].split('/', 1)
        return server, server.split('.')[0], repo

    def acr_digest(self, config, tag):
        _, name, repo = self.registry(config)
        digest = self.capture(['az', 'acr', 'repository', 'show', '-n', name, '--image', f'{repo}:{tag}', '--query', 'digest', '-o', 'tsv'])
        if not re.fullmatch(DIGEST, digest):
            raise DeploymentError('ACR did not return a valid image digest.')
        return digest

    def preflight(self, project):
        config = self.config()
        if project.id != config['projectId']:
            raise DeploymentError(f'Azure stack is bound to another project. Set adapter config projectId to {project.id} for this repository and restart the adapter only if the stack is dedicated to it.')
        runtime = getattr(project, 'runtime', None)
        if runtime:
            port, mode, db_name = runtime['port'], runtime['database']['mode'], runtime['database']['name']
        else:
            port, mode, db_name = project.analysis.port, 'postgres', project.analysis.database_name or 'board_db'
        managed = mode in ('postgres', 'mysql', 'mongodb')
        if port != config['port'] or (managed and db_name != config['dbName']):
            raise DeploymentError('Application port/database must match the prepared Azure stack.')
        # One Azure stack serves one database engine (README 13절). Point AZURE_ADAPTER_CONFIG at the matching stack.
        engine = config.get('dbEngine', 'postgres')
        if managed and mode != engine:
            raise DeploymentError(f'Azure stack database is {engine}; this project needs {mode}. Provision a {mode} stack (AZURE_DATABASE_ENGINE={mode}) and point AZURE_ADAPTER_CONFIG at it.')
        # Refuse other logins (for example a company subscription) before touching any Azure resource.
        if self.capture(['az', 'account', 'show', '--query', 'id', '-o', 'tsv']).lower() != config['subscriptionId'].lower():
            raise DeploymentError('Azure CLI subscription does not match the configured stack.')
        health = self.call('GET', '/health')
        if not health or health.get('target') != 'azure' or health.get('ok') is not True:
            raise DeploymentError('Azure adapter is not ready on 127.0.0.1:9104.')
        return config

    def docker_env(self, auth):
        # A private, temporary Docker config prevents persisting registry tokens in the user's config.
        env = {**os.environ, 'DOCKER_CONFIG': auth}
        if not env.get('DOCKER_HOST') or env.get('DOCKER_CONTEXT'):
            env['DOCKER_HOST'] = self.capture(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
        env.pop('DOCKER_CONTEXT', None)
        return env

    def login_acr(self, config, env):
        server, name, _ = self.registry(config)
        token = self.capture(['az', 'acr', 'login', '-n', name, '--expose-token', '--query', 'accessToken', '-o', 'tsv'])
        self.capture(['docker', 'login', '--username', ACR_TOKEN_USER, '--password-stdin', server], input=token.encode(), env=env)

    def publish(self, source_image, deployment_id):
        """Copy an already published image (ECR) into ACR without changing its digest."""
        config = self.config()
        match = re.fullmatch(rf'({ECR})/[a-z0-9][a-z0-9/_.-]*@({DIGEST})', source_image)
        if not match:
            raise DeploymentError('Azure publishing needs an ECR image pinned by sha256 digest.')
        source_registry, digest = match.groups()
        if os.environ.get('HACKATHON_PUBLISH_PROFILE', 'default') == 'default':
            raise DeploymentError('Copying from ECR needs the named HACKATHON_PUBLISH_PROFILE used for AWS publishing.')
        tag = config['repositoryUri'] + ':' + deployment_id
        with tempfile.TemporaryDirectory(prefix='shakedown-acr-') as auth:
            env = self.docker_env(auth)
            self.login_acr(config, env)
            aws = AwsRunner()
            ecr_token = aws.capture(aws.cli('ecr', 'get-login-password'))
            self.capture(['docker', 'login', '--username', 'AWS', '--password-stdin', source_registry], input=ecr_token.encode(), env=env)
            # A registry-to-registry manifest copy keeps the digest; a second docker push may not.
            self.command(['docker', 'buildx', 'imagetools', 'create', '-t', tag, source_image], 600, env=env)
        copied = self.acr_digest(config, deployment_id)
        if copied != digest:
            raise DeploymentError('ACR image digest differs from the source image; refusing to deploy a different artifact.')
        return config['repositoryUri'] + '@' + digest

    def build_publish(self, project, deployment_id):
        """Azure-only selection: build locally for linux/amd64 and push straight to ACR."""
        config = self.preflight(project)
        tag = config['repositoryUri'] + ':' + deployment_id
        analysis = self.build(project, tag, platform='linux/amd64')
        if analysis.port != config['port'] or (not getattr(project, 'runtime', None) and (analysis.database_name or 'board_db') != config['dbName']):
            raise DeploymentError('Checked-out application no longer matches the Azure stack.')
        with tempfile.TemporaryDirectory(prefix='shakedown-acr-') as auth:
            env = self.docker_env(auth)
            self.login_acr(config, env)
            self.command(['docker', 'push', tag], 900, env=env)
            image = config['repositoryUri'] + '@' + self.acr_digest(config, deployment_id)
            # Cache the exact manifest for the local adapter while credentials are available.
            self.command(['docker', 'pull', '--platform', 'linux/amd64', image], 300, env=env)
        return analysis, image

    def valid_url(self, url):
        return url.rstrip('/') == self.config()['publicUrl'].rstrip('/')

    def call(self, method, path, body=None):
        try:
            with httpx.Client(timeout=150 if method == 'DELETE' else 20, trust_env=False) as client:
                response = client.request(method, self.base + path, json=body)
                response.raise_for_status()
                return response.json() if response.content else None
        except (httpx.HTTPError, ValueError):
            raise DeploymentError('Azure Target request failed; inspect the adapter on 127.0.0.1:9104 and its deployment logs.') from None
