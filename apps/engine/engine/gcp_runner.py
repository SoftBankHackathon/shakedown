"""GCP adapter boundary, single-platform Artifact Registry publishing and digest-preserving copies from ECR/ACR; credentials stay server-side."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import httpx

from engine.aws_runner import AwsRunner
from engine.azure_runner import DIGEST, ECR, AzureRunner
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
        runtime = getattr(project, 'runtime', None)
        if runtime:
            # The adapter offers no database or the prepared Cloud SQL PostgreSQL; the container port is free (Cloud Run sets it per revision).
            mode = runtime['database']['mode']
            if mode not in ('none', 'postgres'):
                raise DeploymentError(f'GCP supports runtime database modes none and postgres only; this project uses {mode}. Deploy it to AWS or Azure.')
            if mode == 'postgres' and runtime['database']['name'] != config['dbName']:
                raise DeploymentError('Runtime database name must match the prepared Cloud SQL database (GCP adapter config dbName).')
        elif project.analysis.port != config['port'] or (project.analysis.database_name or 'board_db') != config['dbName']:
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

    @staticmethod
    def repository(config):
        # build_publish와 publish가 같은 Artifact Registry 저장소에 올리도록 한 곳에서 정한다.
        return config['imagePrefixes'][0] + 'kty-board'

    def docker_env(self, auth):
        # A private, temporary Docker config keeps the access tokens out of the user's Docker config.
        # 빈 설정 폴더에서는 Docker Desktop이 사용자 설정 폴더의 cli-plugins에 둔 buildx를 못 찾는다. 그 폴더와,
        # 사용자가 config.json에 따로 등록한 플러그인 폴더(Homebrew buildx 등)를 알려 준다. 로그인 기록은 옮기지 않는다.
        home = Path(os.environ.get('DOCKER_CONFIG') or Path.home() / '.docker')
        try: extra = json.loads((home / 'config.json').read_text()).get('cliPluginsExtraDirs')
        except (OSError, ValueError, AttributeError): extra = None
        plugins = [str(home / 'cli-plugins'), *(d for d in extra if isinstance(d, str))] if isinstance(extra, list) else [str(home / 'cli-plugins')]
        # auths가 비면 Docker CLI가 OS 키체인(macOS osxkeychain)을 기본 저장소로 골라 토큰이 이 폴더 밖에 남는다.
        # 쓰지 않는 항목 하나를 두어 이 파일에 저장하게 하고, 폴더와 함께 지운다.
        (Path(auth) / 'config.json').write_text(json.dumps({'auths': {'shakedown.invalid': {}}, 'cliPluginsExtraDirs': plugins}))
        env = {**os.environ, 'DOCKER_CONFIG': auth}
        if not env.get('DOCKER_HOST') or env.get('DOCKER_CONTEXT'):
            env['DOCKER_HOST'] = self.capture(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
        env.pop('DOCKER_CONTEXT', None)
        return env

    def ar_digest(self, tag):
        digest = self.capture(['gcloud', 'artifacts', 'docker', 'images', 'describe', tag, '--format=value(image_summary.digest)'])
        if not re.fullmatch(DIGEST, digest):
            raise DeploymentError('Artifact Registry did not return a valid image digest.')
        return digest

    def login_artifact_registry(self, repository, env):
        token = self.capture(['gcloud', 'auth', 'print-access-token'])
        self.capture(['docker', 'login', '--username', 'oauth2accesstoken', '--password-stdin', 'https://' + repository.split('/')[0]], input=token.encode(), env=env)

    def publish(self, source_image, deployment_id):
        """Copy an image another cloud already published (ECR, or the configured ACR) into Artifact Registry without changing its digest."""
        # 엔진은 첫 클라우드에서 한 번만 빌드한다. TARGETS 순서상 GCP는 늘 마지막 클라우드라 빌드 대신 이 복사를 탄다.
        # preflight 전체는 start()가 이미 돌렸다. 설정만 다시 읽어 올릴 저장소를 정한다.
        config = self.config()
        repo, _, digest = source_image.rpartition('@')
        registry, source = repo.split('/')[0], None
        # 첫 클라우드가 자기 설정 저장소에 올린 이미지만 받는다. 같은 레지스트리라도 다른 계정·저장소의 이미지는 거절한다.
        if re.fullmatch(DIGEST, digest):
            if re.fullmatch(ECR, registry):
                # AwsRunner.config()가 이름 있는 HACKATHON_PUBLISH_PROFILE(ECR 로그인에 씀)도 확인한다.
                aws = AwsRunner()
                source = 'ecr' if repo == aws.config()['repositoryUri'] else None
            elif registry.endswith('.azurecr.io'):
                # AWS 없이 Azure와 함께면 Azure가 빌드해 자기 ACR 저장소에 올린다.
                azure = AzureRunner(); azure_config = azure.config()
                source = 'acr' if repo == azure_config['repositoryUri'] else None
        if not source:
            raise DeploymentError('GCP publishing needs the configured ECR or ACR image pinned by sha256 digest.')
        repository = self.repository(config)
        tag = repository + ':' + deployment_id
        with tempfile.TemporaryDirectory(prefix='shakedown-gar-') as auth:
            env = self.docker_env(auth)
            self.login_artifact_registry(repository, env)
            try:
                if source == 'ecr':
                    token = aws.capture(aws.cli('ecr', 'get-login-password'))
                    self.capture(['docker', 'login', '--username', 'AWS', '--password-stdin', registry], input=token.encode(), env=env)
                else:
                    azure.login_acr(azure_config, env)
                # A registry-to-registry manifest copy keeps the digest; a second docker push may not.
                # --prefer-index의 기본값(true)은 단일 manifest를 새 index로 감싸 digest를 바꾸므로 끈다(그대로 복사).
                self.command(['docker', 'buildx', 'imagetools', 'create', '--prefer-index=false', '-t', tag, source_image], 600, env=env)
            except DeploymentError:
                # 첫 클라우드의 빌드·push는 이미 끝났다. AWS·Azure 러너나 로컬 빌드의 문구 대신 이 복사 단계를 가리킨다.
                raise DeploymentError('Copying the image into Artifact Registry failed; check access to the source registry (AWS profile or az login), Artifact Registry permissions and a Docker Buildx whose imagetools create supports --prefer-index. No credentials were logged.') from None
        if self.ar_digest(tag) != digest:
            raise DeploymentError('Artifact Registry image digest differs from the source image; refusing to deploy a different artifact.')
        return repository + '@' + digest

    def build_publish(self, project, deployment_id):
        self.preflight(project)
        config = self.config()
        repository = self.repository(config)
        tag = repository + ':' + deployment_id
        analysis = self.build(project, tag, platform='linux/amd64')
        # With a saved runtime, build() takes the port from it and preflight already checked its database name.
        if not getattr(project, 'runtime', None) and (analysis.port != config['port'] or (analysis.database_name or 'board_db') != config['dbName']):
            raise DeploymentError('Checked-out application no longer matches the GCP service.')
        with tempfile.TemporaryDirectory(prefix='shakedown-gar-') as auth:
            env = self.docker_env(auth)
            self.login_artifact_registry(repository, env)
            self.command(['docker', 'push', tag], 900, env=env)
            image = repository + '@' + self.ar_digest(tag)
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
