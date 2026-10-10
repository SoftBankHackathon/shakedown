"""GCP adapter boundary and single-platform Artifact Registry publishing; credentials stay server-side."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import httpx

from engine.deployments import DeploymentError, LocalRunner, NotFound


class GcpRunner(LocalRunner):
    def __init__(self):
        self.base = 'http://127.0.0.1:9103'

    def config(self):
        path = os.environ.get('GCP_ADAPTER_CONFIG')
        if not path:
            raise DeploymentError('GCP requires GCP_ADAPTER_CONFIG on the engine (the same file as the GCP adapter). Prepare Cloud SQL and Artifact Registry first; see infra/gcp/README.md.')
        try:
            config = json.loads(Path(path).read_text())
            project, number, region = config['gcpProject'], config['gcpProjectNumber'], config['region']
            if (not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', project) or not re.fullmatch(r'\d{6,20}', number)
                    or region != 'asia-northeast3' or not re.fullmatch(r'[a-z][a-z0-9-]{0,47}[a-z0-9]', config['serviceName'])
                    or not re.fullmatch(rf'{region}-docker\.pkg\.dev/{project}/[a-z0-9][a-z0-9._-]*/', config['imagePrefixes'][0])):
                raise ValueError()
            for key in ('projectId', 'port', 'dbName'): config[key]
            return config
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            raise DeploymentError('Invalid GCP adapter configuration; regenerate it with infra/gcp/scripts/provision.sh.') from None

    @staticmethod
    def capture(args, input=None, env=None):
        try:
            result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=120, check=True, env=env)
            return result.stdout.decode().strip()
        except (OSError, subprocess.SubprocessError, UnicodeError):
            raise DeploymentError('GCP publishing command failed; check gcloud login, Artifact Registry permissions and Docker. No credentials were logged.') from None

    def preflight(self, project):
        config = self.config()
        if project.id != config['projectId']:
            raise DeploymentError(f'GCP service is bound to another project. Set adapter config projectId to {project.id} for this repository and restart the GCP adapter with a new GCP_ADAPTER_DB file (its state DB is bound to projectId).')
        if getattr(project, 'runtime', None):
            raise DeploymentError('GCP supports only the PostgreSQL sample contract; saved runtime settings are not supported yet. Clear the runtime or deploy to AWS.')
        if project.analysis.port != config['port'] or (project.analysis.database_name or 'board_db') != config['dbName']:
            raise DeploymentError('Application port/database must match the prepared GCP service.')
        try:
            active = self.capture(['gcloud', 'config', 'get', 'project'])
        except DeploymentError:
            # Nothing has been built yet: point at the engine's gcloud, not at registry publishing.
            raise DeploymentError('gcloud CLI is not available to the engine; start the engine with the Google Cloud SDK on PATH and run gcloud auth login.') from None
        if active != config['gcpProject']:
            raise DeploymentError('gcloud active project does not match the configured GCP project; run gcloud config set project first.')
        health = self.call('GET', '/health')
        if not health or health.get('target') != 'gcp' or health.get('ok') is not True:
            raise DeploymentError('GCP adapter is not ready on 127.0.0.1:9103.')

    def build_publish(self, project, deployment_id):
        self.preflight(project)
        config = self.config()
        repository = config['imagePrefixes'][0] + 'kty-board'
        tag = repository + ':' + deployment_id
        analysis = self.build(project, tag, platform='linux/amd64')
        if analysis.port != config['port'] or (analysis.database_name or 'board_db') != config['dbName']:
            raise DeploymentError('Checked-out application no longer matches the GCP service.')
        registry = repository.split('/')[0]
        # A private, temporary Docker config keeps the access token out of the user's Docker config.
        with tempfile.TemporaryDirectory(prefix='shakedown-gar-') as auth:
            env = {**os.environ, 'DOCKER_CONFIG': auth}
            if not env.get('DOCKER_HOST') or env.get('DOCKER_CONTEXT'):
                env['DOCKER_HOST'] = self.capture(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
            env.pop('DOCKER_CONTEXT', None)
            token = self.capture(['gcloud', 'auth', 'print-access-token'])
            self.capture(['docker', 'login', '--username', 'oauth2accesstoken', '--password-stdin', 'https://' + registry], input=token.encode(), env=env)
            self.command(['docker', 'push', tag], 900, env=env)
            digest = self.capture(['gcloud', 'artifacts', 'docker', 'images', 'describe', tag, '--format=value(image_summary.digest)'])
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
                raise DeploymentError('Artifact Registry did not return a valid image digest.')
            image = repository + '@' + digest
            # Cache the exact manifest for the local adapter while credentials are available.
            self.command(['docker', 'pull', '--platform', 'linux/amd64', image], 300, env=env)
        return analysis, image

    def valid_url(self, url):
        config = self.config()
        return url.rstrip('/') == f"https://{config['serviceName']}-{config['gcpProjectNumber']}.{config['region']}.run.app"

    def call(self, method, path, body=None):
        try:
            # DELETE waits for zero instances on the adapter (scale-down operation + up to 15 s public check).
            with httpx.Client(timeout=60 if method == 'DELETE' else 20, trust_env=False) as client:
                response = client.request(method, self.base + path, json=body)
                response.raise_for_status()
                return response.json() if response.content else None
        except httpx.HTTPStatusError as error:
            # 404는 어댑터가 그 배포 ID를 모른다는 답이다. 수정 재배포 POST가 거절됐는지 확인하는 데 쓰므로 따로 알린다.
            kind = NotFound if error.response.status_code == 404 else DeploymentError
            raise kind('GCP Target request failed; inspect the adapter on 127.0.0.1:9103 and its deployment logs.') from None
        except (httpx.HTTPError, ValueError):
            raise DeploymentError('GCP Target request failed; inspect the adapter on 127.0.0.1:9103 and its deployment logs.') from None
