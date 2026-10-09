"""AWS adapter boundary and single-platform ECR publishing; credentials stay server-side."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import httpx

from engine.deployments import DeploymentError, LocalRunner


class AwsRunner(LocalRunner):
    def __init__(self):
        self.base = 'http://127.0.0.1:9102'

    def config(self):
        path = os.environ.get('AWS_ADAPTER_CONFIG')
        profile = os.environ.get('HACKATHON_PUBLISH_PROFILE')
        if not path or not profile or profile == 'default':
            raise DeploymentError('AWS requires AWS_ADAPTER_CONFIG and a named HACKATHON_PUBLISH_PROFILE on the engine. Prepare the ECS stack and schema first; see infra/aws/README.md.')
        try:
            config = json.loads(Path(path).read_text())
            account, region, repo = config['accountId'], config['region'], config['repository']
            if (not re.fullmatch(r'\d{12}', account) or region != 'ap-northeast-2'
                    or not re.fullmatch(r'[a-z0-9][a-z0-9/_-]+', repo)
                    or config['repositoryUri'] != f'{account}.dkr.ecr.{region}.amazonaws.com/{repo}'):
                raise ValueError()
            if not re.fullmatch(r'http://[a-zA-Z0-9.-]+\.elb\.amazonaws\.com/?', config['publicUrl']):
                raise ValueError()
            for key in ('projectId', 'port', 'dbName'): config[key]
            return config
        except (OSError, ValueError, KeyError, TypeError):
            raise DeploymentError('Invalid AWS adapter configuration; regenerate it from stack outputs.') from None

    @staticmethod
    def capture(args, input=None, env=None):
        try:
            result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=120, check=True, env=env)
            return result.stdout.decode().strip()
        except (OSError, subprocess.SubprocessError, UnicodeError):
            raise DeploymentError('AWS publishing command failed; check the named profile, permissions and Docker. No credentials were logged.') from None

    def cli(self, *args):
        return ['aws', '--profile', os.environ['HACKATHON_PUBLISH_PROFILE'], '--region', 'ap-northeast-2', *args]

    def preflight(self, project):
        config = self.config()
        if project.id != config['projectId']:
            raise DeploymentError(f'AWS stack is bound to another project. Set adapter config projectId to {project.id} for this repository and restart the adapter only if the stack is dedicated to it.')
        if project.analysis.port != config['port'] or (project.analysis.database_name or 'board_db') != config['dbName']:
            raise DeploymentError('Application port/database must match the prepared AWS stack.')
        if self.capture(self.cli('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')) != config['accountId']:
            raise DeploymentError('AWS publisher account does not match the configured stack.')
        health = self.call('GET', '/health')
        if not health or health.get('target') != 'aws' or health.get('ok') is not True:
            raise DeploymentError('AWS adapter is not ready on 127.0.0.1:9102.')

    def validate_architecture(self, architecture):
        config = self.config()
        if not config.get('dbInstanceId') or len(set(config.get('subnetIds', []))) < architecture['availability_zones']:
            raise DeploymentError('선택 설계용 기반 스택이 필요합니다. foundation.yaml을 갱신하고 DB 식별자와 AZ별 서브넷 설정을 다시 생성하세요.')

    def build_publish(self, project, deployment_id):
        self.preflight(project)
        config = self.config()
        tag = config['repositoryUri'] + ':' + deployment_id
        analysis = self.build(project, tag, platform='linux/amd64')
        if analysis.port != config['port'] or (analysis.database_name or 'board_db') != config['dbName']:
            raise DeploymentError('Checked-out application no longer matches the AWS stack.')
        registry = config['repositoryUri'].split('/')[0]
        # A private, temporary Docker config prevents persisting ECR tokens in the user's config.
        with tempfile.TemporaryDirectory(prefix='shakedown-ecr-') as auth:
            env = {**os.environ, 'DOCKER_CONFIG': auth}
            if not env.get('DOCKER_HOST') or env.get('DOCKER_CONTEXT'):
                env['DOCKER_HOST'] = self.capture(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
            env.pop('DOCKER_CONTEXT', None)
            token = self.capture(self.cli('ecr', 'get-login-password'))
            self.capture(['docker', 'login', '--username', 'AWS', '--password-stdin', registry], input=token.encode(), env=env)
            self.command(['docker', 'push', tag], 900, env=env)
            digest = self.capture(self.cli('ecr', 'describe-images', '--repository-name', config['repository'],
                                          '--image-ids', 'imageTag=' + deployment_id, '--query', 'imageDetails[0].imageDigest', '--output', 'text'))
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
                raise DeploymentError('ECR did not return a valid image digest.')
            image = config['repositoryUri'] + '@' + digest
            # Cache the exact manifest for the local adapter while credentials are available.
            self.command(['docker', 'pull', '--platform', 'linux/amd64', image], 300, env=env)
        return analysis, image

    def valid_url(self, url):
        return url.rstrip('/') == self.config()['publicUrl'].rstrip('/')

    def call(self, method, path, body=None):
        try:
            with httpx.Client(timeout=630 if method == 'DELETE' else 20, trust_env=False) as client:
                response = client.request(method, self.base + path, json=body)
                response.raise_for_status()
                return response.json() if response.content else None
        except (httpx.HTTPError, ValueError):
            raise DeploymentError('AWS Target request failed; inspect the adapter on 127.0.0.1:9102 and its deployment logs.') from None
