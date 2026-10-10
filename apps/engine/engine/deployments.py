"""Local and pre-provisioned cloud (AWS, Azure, GCP) orchestration. Never fabricates a shakedown verdict."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import uuid

import httpx
from engine.analyzer import RepoAnalyzer
from engine.models import Model, Project
from pydantic import Field, field_validator
from urllib.parse import urlsplit
from typing import Literal

TERMINAL = {'deployed', 'promoted', 'warned', 'blocked', 'failed'}

# Per-target limits. Clouds are pre-provisioned stacks behind loopback adapters (infra/aws, infra/azure, infra/gcp).
# Order matters: the first selected target is the shakedown baseline (local when selected).
TARGETS = {
    'local': dict(label='Local Docker', replicas=(1,), sticky=False, replicas_default=1, tz='Asia/Seoul'),
    'aws': dict(label='AWS ECS', replicas=(1, 2), sticky=False, replicas_default=2, tz='UTC'),
    # Container Apps ingress affinity is an Azure-native fix for in-memory sessions.
    'azure': dict(label='Azure Container Apps', replicas=(1, 2), sticky=True, replicas_default=2, tz='UTC'),
    # Cloud Run session affinity is best-effort.
    'gcp': dict(label='GCP Cloud Run', replicas=(1, 2), sticky=True, replicas_default=2, tz='UTC'),
}
CLOUDS = ('aws', 'azure', 'gcp')
# 차단 뒤 env를 바꿔 같은 이미지로 다시 배포할 수 있는 클라우드. AWS는 같은 경로를 타지만 실계정에서
# 재배포(새 배포 ID로 ECS 서비스 재생성)를 아직 검증하지 않아서, 검증 전까지는 수정안을 제안만 한다.
ENV_FIX_TARGETS = {'gcp'}
# 엔진이 자동으로 적용하는 수정안 값 → 대상 API 본문의 env. 보고서가 다른 값을 내도 이 목록 밖은 적용하지 않는다.
# 값은 GCP 어댑터가 받는 프로필 목록(infra/gcp/src/config.ts의 validateRequest)과 같다.
ENV_FIXES = {'SPRING_PROFILES_ACTIVE=demo,session-jdbc': {'SPRING_PROFILES_ACTIVE': 'demo,session-jdbc'}}
VERDICT_RANK = ('PASS', 'WARN', 'BLOCKED')

class Endpoint(Model):
    name: str = Field(min_length=1, max_length=40, pattern=r'^[a-z][a-z0-9_-]*$')
    url: str

    @field_validator('url')
    @classmethod
    def valid_url(cls, value):
        p = urlsplit(value)
        if p.scheme not in {'http', 'https'} or not p.hostname or p.username or p.password or p.query or p.fragment or p.path not in {'', '/'}:
            raise ValueError('Use an HTTP(S) origin without credentials, path, query or fragment.')
        return value.rstrip('/')

class CompareRequest(Model):
    baseline: Endpoint
    candidate: Endpoint


class DeployRequest(Model):
    architecture_plan_id: str | None = Field(default=None, pattern=r"^arch_[a-f0-9]{32}$")
    shakedown: bool = False
    autofix: bool = False
    comparison: Endpoint | None = None
    targets: list[Literal['local', 'aws', 'azure', 'gcp']] = Field(default_factory=lambda: ['local'], min_length=1, max_length=3)
    options: dict[str, dict] = Field(default_factory=dict)

class DeploymentError(Exception):
    pass

class Busy(DeploymentError):
    pass

class NotFound(DeploymentError):
    """대상 어댑터가 그 배포 ID를 모른다(404). 재배포 POST가 거절됐는지, 응답만 잃었는지 가르는 근거다."""
    pass

class LocalRunner:
    def __init__(self):
        # Deliberately fixed loopback destination; caller input cannot select an HTTP endpoint.
        self.base = 'http://127.0.0.1:9101'

    @contextmanager
    def source(self, repo):
        if '://' not in repo:
            yield Path(repo).resolve(strict=True)
            return
        url = RepoAnalyzer.github_url(repo)
        with tempfile.TemporaryDirectory(prefix='shakedown-build-') as tmp:
            root = Path(tmp) / 'repo'
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_LFS_SKIP_SMUDGE': '1',
                   'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
            self.command(['git', '-c', 'core.hooksPath=' + os.devnull, '-c', 'init.templateDir=',
                          '-c', 'core.symlinks=false', 'clone', '--depth', '1', '--', url, str(root)], 90, env)
            yield root

    @staticmethod
    def command(args, timeout, env=None):
        try:
            subprocess.run(args, check=True, timeout=timeout, env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            raise DeploymentError(f'{args[0]} failed or timed out; inspect the local build environment.') from None

    # NOTE(conflict): PR #11/#12 (codex/image-builder, codex/architecture-planner) rewrite this method.
    # Azure work does not touch it; keep Azure changes out of LocalRunner.build.
    def build(self, project, image, platform=None):
        with self.source(project.repo) as root:
            # Re-analyze the actual checkout, rather than trusting an earlier branch revision.
            from engine.analyzer import ImageRepoAnalyzer
            analysis = ImageRepoAnalyzer().analyze(str(root))
            if getattr(project,'runtime',None):
                from engine.runtime import database_conflict
                conflict = database_conflict(project.runtime['database']['mode'], analysis.database)
                if conflict: raise DeploymentError(conflict)
                analysis.port=project.runtime['port']; analysis.health_path=project.runtime['health_path']
            from engine.image_builder import app_context, prepared, BuildError
            from engine.llm import LlmError
            try:
                context = app_context(root, analysis)
                if not getattr(project, 'runtime', None) and analysis.database not in {'postgres', 'postgresql'}:
                    raise DeploymentError('Deployment currently requires the PostgreSQL sample application; use image build for other stacks.')
                def build_at(path):
                    command = ['docker', 'build', '-t', image, str(path)] if platform is None else ['docker', 'buildx', 'build', '--platform', platform, '--provenance=false', '--sbom=false', '--load', '-t', image, str(path)]
                    self.command(command, 900)
                # Existing Dockerfiles must use the same checked, isolated path.
                with prepared(context, analysis, llm=getattr(self, 'llm', None), security_root=root) as (staged, _plan):
                    build_at(staged)
            except (BuildError, LlmError) as exc:
                raise DeploymentError(str(exc)) from None
            return analysis

    def call(self, method, path, body=None):
        try:
            with httpx.Client(timeout=20, trust_env=False) as client:
                response = client.request(method, self.base + path, json=body)
                response.raise_for_status()
                return response.json() if response.content else None
        except (httpx.HTTPError, ValueError):
            raise DeploymentError('Local Target request failed; check the service on 127.0.0.1:9101 and its deployment logs.') from None

class ShakedownClient:
    def call(self, method, path, body=None):
        try:
            with httpx.Client(timeout=20, trust_env=False) as client:
                response = client.request(method, 'http://127.0.0.1:9201' + path, json=body)
                response.raise_for_status()
                return response.json()
        except (httpx.HTTPError, ValueError):
            raise DeploymentError('Shakedown request failed; check 127.0.0.1:9201. No PASS was recorded.') from None

class DeploymentStore:
    def __init__(self, path: Path, runner=None, poll_seconds=1, timeout=300, shakedown=None, shakedown_timeout=180, aws=None, azure=None, gcp=None):
        self.shakedown = shakedown or ShakedownClient()
        self.shakedown_timeout = shakedown_timeout
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.runner = runner or LocalRunner()
        # Imported here: the runner modules import this one.
        from engine.aws_runner import AwsRunner
        from engine.azure_runner import AzureRunner
        from engine.gcp_runner import GcpRunner
        self.aws = aws or AwsRunner()
        self.azure = azure or AzureRunner()
        self.gcp = gcp or GcpRunner()
        self.poll_seconds, self.timeout = poll_seconds, timeout
        self.pool = ThreadPoolExecutor(max_workers=2)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, payload TEXT)')
            db.execute('DROP INDEX IF EXISTS active_project')
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS active_project ON deployments(project_id) WHERE status NOT IN ('deployed','promoted','warned','blocked','failed')")
            rows = db.execute("SELECT payload FROM deployments WHERE status NOT IN ('deployed','promoted','warned','blocked','failed')").fetchall()
            for row in rows:
                d = json.loads(row[0]); d.update(status='failed', finished=time.time(), error='Engine restarted during deployment. Inspect target resources before retrying.')
                db.execute('UPDATE deployments SET status=?, payload=? WHERE id=?', ('failed', json.dumps(d), d['id']))

    def runner_for(self, target):
        return {'local': self.runner, 'aws': self.aws, 'azure': self.azure, 'gcp': self.gcp}[target]

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db: yield db
        finally: db.close()

    def save(self, d):
        with self.connect() as db:
            db.execute('UPDATE deployments SET status=?,payload=? WHERE id=?', (d['status'], json.dumps(d), d['id']))

    def get(self, id):
        with self.connect() as db:
            row = db.execute('SELECT payload FROM deployments WHERE id=?', (id,)).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, project_id=None):
        with self.connect() as db:
            rows = db.execute('SELECT payload FROM deployments WHERE (? IS NULL OR project_id=?) ORDER BY rowid DESC', (project_id, project_id)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def start(self, project: Project, request: DeployRequest):
        if request.autofix:
            raise DeploymentError('Automatic fixes are not supported; review the suggested fix manually.')
        targets = [name for name in TARGETS if name in request.targets]
        if len(targets) != len(request.targets):
            raise DeploymentError('Targets must be unique.')
        clouds = [name for name in targets if name in CLOUDS]
        if 'gcp' in clouds and len(clouds) > 1:
            # GCP는 다른 클라우드 저장소로 같은 digest를 복사(publish)하지 않는다. 지금은 Local + GCP만 받는다.
            raise DeploymentError('GCP cannot be combined with another cloud yet; select Local and GCP only.')
        if request.comparison and (len(targets) != 1 or request.comparison.name in targets):
            raise DeploymentError('An external comparison requires one deployed target and a distinct name.')
        if request.shakedown != (request.comparison is not None or len(targets) >= 2):
            raise DeploymentError('Shakedown requires two deployment targets or an existing comparison endpoint.')
        if set(request.options) - set(targets):
            raise DeploymentError('Options must belong to selected targets.')
        architecture = None
        if request.architecture_plan_id:
            if 'aws' not in targets:
                raise DeploymentError('An architecture plan requires the AWS target.')
            if not getattr(self, 'architecture', None):
                raise DeploymentError('Architecture planner is unavailable.')
            architecture = self.architecture.resolve(project, request.architecture_plan_id)
            if 'replicas' in request.options.get('aws', {}):
                raise DeploymentError('Selected architecture controls AWS replicas; remove the replica override.')
        options = {}
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        for target in targets:
            spec = TARGETS[target]
            opts = {'replicas': spec['replicas_default'], 'sticky_sessions': False, 'tz': spec['tz']}
            opts.update(request.options.get(target, {}))
            try:
                ZoneInfo(opts['tz'])
            except (ZoneInfoNotFoundError, TypeError, ValueError):
                raise DeploymentError('Invalid timezone.') from None
            if (set(opts) != {'replicas','sticky_sessions','tz'} or type(opts['replicas']) is not int
                    or opts['replicas'] not in spec['replicas'] or type(opts['sticky_sessions']) is not bool
                    or (opts['sticky_sessions'] and not spec['sticky'])):
                raise DeploymentError('Local supports one replica; clouds support one or two. Only Azure and GCP support sticky sessions.')
            if target == 'aws' and architecture:
                opts['replicas'] = architecture['min_tasks']
            options[target] = opts
        for target in targets:
            if target in CLOUDS: self.runner_for(target).preflight(project)
        if architecture: self.aws.validate_architecture(architecture, project)
        d = dict(id='dep_' + uuid.uuid4().hex, project_id=project.id, created=time.time(), status='queued',
                 shakedown=request.shakedown, autofix=False, options=options, targets={name: {'status':'pending','label': TARGETS[name]['label']} for name in targets},
                 architecture=architecture, architecture_plan_id=request.architecture_plan_id, attempts=[], timings={}, ai_cost=dict(calls=0,input_tokens=0,output_tokens=0,krw=0))
        try:
            with self.connect() as db:
                db.execute('INSERT INTO deployments VALUES (?,?,?,?)', (d['id'], project.id, d['status'], json.dumps(d)))
        except sqlite3.IntegrityError:
            raise Busy('A deployment is already running for this project.') from None
        self.pool.submit(self.run, project, json.loads(json.dumps(d)), request.comparison)
        return d

    @staticmethod
    def target_id(d, target):
        # 대상 API에 실제로 쓴 배포 ID. 수정 재배포 뒤에는 새 ID라서, 그 뒤의 조회·로그·DELETE는 이 ID로 보낸다.
        return d['targets'][target].get('deployment_id', d['id'])

    def submit(self, d, target, body):
        self.runner_for(target).call('POST', '/deployments', body)
        # 받아들여진 본문을 남긴다. 수정 재배포는 이 본문(같은 이미지·포트·DB·옵션)에 env만 더해 다시 보낸다.
        d['targets'][target].update(deployment_id=body['deployment_id'], request={k: v for k, v in body.items() if k != 'deployment_id'})
        self.save(d)

    def wait_ready(self, d, target):
        runner = self.runner_for(target)
        deadline = time.monotonic() + (max(self.timeout, 2700) if target == 'aws' and d.get('architecture') else self.timeout)
        while time.monotonic() < deadline:
            state = runner.call('GET', '/deployments/' + self.target_id(d, target))
            if state.get('status') == 'failed': raise DeploymentError(f'{target} deployment failed; inspect its logs.')
            if state.get('status') == 'ready':
                url = urlsplit(state.get('url', ''))
                valid = (url.scheme == 'https' and (url.hostname or '').endswith('.trycloudflare.com')) if target == 'local' else runner.valid_url(state.get('url', ''))
                if not valid: raise DeploymentError(f'{target} returned an invalid public URL.')
                d['targets'][target].update({k:v for k,v in state.items() if k in {'status','url','instances','info'}})
                self.save(d)
                return
            time.sleep(self.poll_seconds)
        raise DeploymentError(f'{target} deployment readiness timed out.')

    def cleanup(self, d, targets):
        blocked = []
        for target in reversed(targets):
            runner = self.runner_for(target)
            if target in CLOUDS:
                try:
                    # Collect evidence before DELETE stops tasks. Do not persist raw application logs.
                    runner.call('GET', '/deployments/' + self.target_id(d, target) + '/logs')
                    d['targets'][target]['logs_collected'] = True
                except Exception:
                    d['targets'][target]['logs_collected'] = False
            try:
                runner.call('DELETE', '/deployments/' + self.target_id(d, target))
                d['targets'][target]['cleanup'] = 'confirmed'
                d['targets'][target]['status'] = 'stopped'
                d['targets'][target]['instances'] = 0
                if target in CLOUDS: blocked.append(True)
            except Exception:
                d['targets'][target]['cleanup'] = 'failed'
                d['targets'][target]['status'] = 'failed'
                d['error'] = d.get('error', '') + f' {target} cleanup failed; inspect the adapter and retry DELETE.'
                if target in CLOUDS: blocked.append(False)
        if blocked: d['traffic_blocked'] = all(blocked)

    def run(self, project, d, comparison=None):
        submitted = []
        try:
            d['status'] = 'building'; self.save(d)
            start = time.monotonic()
            image = 'shakedown/engine:' + d['id']
            clouds = [t for t in d['targets'] if t in CLOUDS]
            images = {}
            if clouds:
                # Build once, push to the first cloud's registry, then copy the same digest to the others.
                analysis, image = self.runner_for(clouds[0]).build_publish(project, d['id'])
                images[clouds[0]] = image
                for cloud in clouds[1:]:
                    images[cloud] = self.runner_for(cloud).publish(image, d['id'])
            else:
                analysis = self.runner.build(project, image)
            d['image'] = image; d['timings']['build_s'] = time.monotonic() - start
            d['status'] = 'deploying'; self.save(d)
            start = time.monotonic()
            for target in d['targets']:
                d['targets'][target]['status'] = 'deploying'; self.save(d)
                body = dict(deployment_id=d['id'], project_id=project.id, image=images.get(target, image), port=analysis.port,
                            health_path=analysis.health_path, database={'engine':'postgres','name':analysis.database_name or 'board_db'},
                            secret_refs={'SPRING_DATASOURCE_PASSWORD':'db_password'}, options=d['options'][target])
                if target == 'aws' and d.get('architecture'):
                    # Only server-resolved catalog IDs cross the adapter boundary.
                    body['architecture'] = {'version': 'aws-architecture.v1', 'template_id': d['architecture']['id']}
                    if not project.runtime: body['env'] = {'SPRING_PROFILES_ACTIVE': 'demo,session-jdbc'}
                if project.runtime:
                    body.pop('database',None); body.pop('secret_refs',None)
                    body['runtime']=project.runtime
                    body['port']=project.runtime['port']; body['health_path']=project.runtime['health_path']
                submitted.append(target)
                self.submit(d, target, body)
                self.wait_ready(d, target)
            d['timings']['deploy_s'] = time.monotonic() - start
            d['status'] = 'deployed'
            baseline, *others = d['targets']
            # The shakedown runner compares one candidate at a time, so each cloud gets its own run against the baseline.
            candidates = [Endpoint(name=t, url=d['targets'][t]['url']) for t in others] or ([comparison] if comparison else [])
            if candidates:
                # 외부 비교 URL은 엔진이 배포한 게 아니라서 env를 바꿀 수 없다. 엔진이 Local과 함께 배포한 클라우드 하나만 자동 수정 대상이다.
                results = self.compare(d, Endpoint(name=baseline, url=d['targets'][baseline]['url']), candidates, project,
                                       can_apply_env=len(others) == 1 and others[0] in ENV_FIX_TARGETS)
                # Close only the managed clouds that failed; with an external comparison the deployed side is judged.
                failed = {name for name, result in results.items() if result == 'BLOCKED'}
                if comparison and failed: failed = set(submitted)
                blocked = [t for t in submitted if t in CLOUDS and t in failed]
                if blocked: self.cleanup(d, blocked)
        except Exception as exc:
            d['status'] = 'failed'
            d['error'] = str(exc) if isinstance(exc, DeploymentError) else 'Deployment failed; inspect the engine environment.'
            for target in d['options']:
                d['targets'][target].update(status='failed', error=d['error'])
            self.cleanup(d, submitted)
        finally:
            d['finished'] = time.time(); d['timings']['total_s'] = d['finished'] - d['created']; self.save(d)

    def apply_fix(self, project, id):
        """차단된 배포에 규칙 수정안(env)을 한 번 적용한다. 클라우드만 새 ID로 다시 배포하고 2회차 시운전을 돌린다."""
        d = self.get(id)
        if d['status'] != 'blocked':
            raise Busy(f'Only a blocked deployment can be fixed; this one is {d["status"]}.')
        # GCP 어댑터는 서비스 하나만 다룬다. 옛 차단 배포를 고치면 더 새 배포가 쓰는 서비스를 덮어쓴다.
        if self.list(d['project_id'])[0]['id'] != id:
            raise Busy('Only the latest deployment of this project can be fixed; start a new deployment instead.')
        cloud = next((name for name in d['options'] if name != 'local'), None)
        target = d['targets'].get(cloud, {})
        if 'local' not in d['options'] or cloud not in ENV_FIX_TARGETS or 'request' not in target:
            raise DeploymentError('Fixes are applied only to a Local + GCP deployment made by the engine; apply this fix manually.')
        if len(d['attempts']) != 1:
            raise DeploymentError('This deployment was already fixed once; start a new deployment.')
        if target.get('cleanup') != 'confirmed':
            raise DeploymentError(f'The blocked {cloud} deployment was not confirmed stopped; retry its DELETE on the adapter first.')
        fix = (d['attempts'][0].get('report') or {}).get('fix') or {}
        if not (fix.get('auto_applicable') is True and fix.get('target') == cloud and fix.get('option') == 'env' and fix.get('value') in ENV_FIXES):
            raise DeploymentError('This fix is not automatically applicable; apply it manually.')
        self.runner_for(cloud).preflight(project)
        d['attempts'][0]['applied_fix'] = fix
        d['status'] = 'fixing'
        d.pop('finished', None)
        # 1회차 총시간은 수정이 끝나면 2회차 작업 시간을 더해 다시 채운다. 그 사이에는 지금 값처럼 보이지 않게 뺀다.
        spent = d['timings'].pop('total_s', 0)
        with self.connect() as db:
            # 확인한 뒤 같은 프로젝트의 새 배포가 끼어들었거나 이미 다른 요청이 수정을 시작했으면 바꾸지 않는다.
            changed = db.execute("UPDATE deployments SET status=?, payload=? WHERE id=? AND status='blocked' "
                                 "AND rowid=(SELECT MAX(rowid) FROM deployments WHERE project_id=?)",
                                 (d['status'], json.dumps(d), id, d['project_id'])).rowcount
        if changed != 1:
            raise Busy('The deployment changed while applying the fix; reload it and try again.')
        self.pool.submit(self.run_fix, project, json.loads(json.dumps(d)), cloud, ENV_FIXES[fix['value']], spent)
        return d

    def run_fix(self, project, d, cloud, env, spent=0):
        started = time.time()
        target = d['targets'][cloud]
        # 1회차 차단 기록(정리 확인됨). 재배포 POST가 거절돼 새 ID가 어댑터에 없으면 이 기록으로 되돌린다.
        blocked, traffic_blocked = dict(target), d.get('traffic_blocked')
        # 새 ID는 엔진 배포 ID와 같은 36자 모양이다(접미사로 늘리면 AWS ECS clientToken 36자 제한을 넘는다).
        new_id = 'dep_' + uuid.uuid4().hex
        managed, accepted = ['local', cloud], False
        try:
            # POST 전에 새 ID를 기록한다. 응답을 못 받은 실패(시간 초과·연결 끊김)는 어댑터가 이미 접수해 배포를
            # 시작했을 수 있어서, 실패 처리가 이 ID로 정리해야 공개 주소가 기록 없이 다시 열린 채로 남지 않는다.
            # 새 배포가 공개 주소를 다시 열 것이므로 1회차 정리 기록과 차단 표시는 더 이상 지금 상태가 아니다.
            for key in ('cleanup', 'logs_collected'): target.pop(key, None)
            target.update(status='deploying', deployment_id=new_id); d['traffic_blocked'] = False; self.save(d)
            # 빌드하지 않는다. 1회차 본문(같은 digest·포트·DB·옵션)에 env만 더한다.
            deploying = time.monotonic()
            self.submit(d, cloud, {**blocked['request'], 'deployment_id': new_id, 'env': env})
            accepted = True
            self.wait_ready(d, cloud)
            # 대시보드의 분해(빌드·배포·시운전)가 총시간을 설명하도록 재배포 시간을 배포 시간에 더한다.
            d['timings']['deploy_s'] = d['timings'].get('deploy_s', 0) + time.monotonic() - deploying
            # 2회차 수정안은 자동으로 다시 적용하지 않으므로 can_apply_env 힌트를 주지 않는다.
            self.compare(d, Endpoint(name='local', url=d['targets']['local']['url']), [Endpoint(name=cloud, url=target['url'])], project)
            if d['status'] == 'blocked':
                self.cleanup(d, [cloud])
        except Exception as exc:
            d['status'] = 'failed'
            d['error'] = str(exc) if isinstance(exc, DeploymentError) else 'Fix redeploy failed; inspect the engine environment.'
            if not accepted:
                try:
                    self.runner_for(cloud).call('GET', '/deployments/' + new_id)
                except NotFound:
                    # 어댑터가 새 ID를 모른다 = POST가 거절됐다. 지울 것이 없으니 1회차 정리 기록을 그대로 둔다
                    # (그 ID로 DELETE하면 404가 정리 실패로 기록돼 이미 확인된 차단이 failed로 바뀐다).
                    d['targets'][cloud], d['traffic_blocked'] = blocked, traffic_blocked
                    managed.remove(cloud)
                except Exception:
                    pass  # 접수됐는지 모른다. 아래 정리가 새 ID로 DELETE하고, 실패하면 정리 실패로 남긴다.
            for name in managed:
                d['targets'][name].update(status='failed', error=d['error'])
            self.cleanup(d, managed)
        finally:
            # 차단 뒤 수정 버튼을 누르기까지 기다린 시간은 작업 시간이 아니므로 빼고, 1회차 총시간에 이번 작업 시간만 더한다.
            d['finished'] = time.time(); d['timings']['total_s'] = spent + d['finished'] - started; self.save(d)

    def start_comparison(self, project, request: CompareRequest):
        if request.baseline.name == request.candidate.name or request.baseline.url == request.candidate.url:
            raise DeploymentError('Use two distinct environments with distinct names.')
        d = dict(id='dep_' + uuid.uuid4().hex, project_id=project.id, created=time.time(), status='queued',
                 shakedown=True, autofix=False, options={}, targets={}, attempts=[], timings={},
                 ai_cost=dict(calls=0,input_tokens=0,output_tokens=0,krw=0), mode='comparison')
        try:
            with self.connect() as db:
                db.execute('INSERT INTO deployments VALUES (?,?,?,?)', (d['id'], project.id, d['status'], json.dumps(d)))
        except sqlite3.IntegrityError:
            raise Busy('A deployment or comparison is already running for this project.') from None
        self.pool.submit(self.run_comparison, project, json.loads(json.dumps(d)), request)
        return d

    def run_comparison(self, project, d, request):
        try:
            self.compare(d, request.baseline, [request.candidate], project)
        except Exception as exc:
            d['status'] = 'failed'
            d['error'] = str(exc) if isinstance(exc, DeploymentError) else 'Comparison failed; no PASS was recorded.'
        finally:
            d['finished'] = time.time(); d['timings']['total_s'] = d['finished'] - d['created']; self.save(d)

    def compare(self, d, baseline, candidates, project, can_apply_env=False):
        """Run one shakedown per candidate against the same baseline. Returns {candidate: PASS|WARN|BLOCKED}."""
        if any(baseline.url == c.url for c in candidates):
            raise DeploymentError('Cannot compare an environment with itself.')
        # Registered URLs are existing environments. Never deploy/delete someone else's resources.
        for target in (baseline, *candidates):
            if target.name not in d['targets']:
                d['targets'][target.name] = dict(status='external', label='Existing environment (not managed by engine)', url=target.url)
        d['status'] = 'shakedown'
        # 수정 적용 뒤의 시운전은 1회차 기록 뒤에 2회차로 덧붙인다.
        attempt = dict(n=len(d['attempts']) + 1, options=d['options'], steps=[], duration_s=0)
        d['attempts'].append(attempt)
        self.save(d)
        results, verdicts, reports = {}, {}, {}
        for candidate in candidates:
            verdicts[candidate.name], reports[candidate.name] = self.shakedown_one(d, attempt, baseline, candidate, project, can_apply_env)
            results[candidate.name] = verdicts[candidate.name]['status']
        worst = max(results, key=lambda name: VERDICT_RANK.index(results[name]))
        attempt['verdict'] = verdicts[worst]
        attempt['report'] = reports[worst]
        result = results[worst]
        d['status'] = {'PASS':'promoted', 'WARN':'warned', 'BLOCKED':'blocked'}[result]
        d['release_gate'] = 'blocked' if result == 'BLOCKED' else 'review' if result == 'WARN' else 'passed'
        d['traffic_blocked'] = False
        return results

    def shakedown_one(self, d, attempt, baseline, candidate, project, can_apply_env=False):
        """One baseline/candidate run. Its rows are appended to the attempt (each row names its candidate)."""
        prior = list(attempt['steps'])
        # 시운전은 이번 실행의 AI 비용만 알려 준다. 앞 회차·앞 클라우드 비용을 잃지 않게 시작 전까지의 합에 더한다.
        cost_before = d['ai_cost']
        hints = {'uses_server_session': project.analysis.uses_server_session}
        if can_apply_env:
            # 시운전은 이 힌트가 있을 때만 env 수정안을 자동 적용 가능(auto_applicable)으로 표시한다.
            hints['can_apply_env'] = True
        body = dict(deployment_id=d['id'], project_id=project.id, baseline=baseline.model_dump(),
                    candidates=[candidate.model_dump()], hints=hints)
        started = time.monotonic()
        state = self.shakedown.call('POST', '/shakedowns', body)
        id = state.get('shakedown_id', '')
        import re
        if not re.fullmatch(r'sd_[a-zA-Z0-9]+', id):
            raise DeploymentError('Invalid shakedown ID returned by runner.')
        d['shakedown_id'] = id
        spent = attempt['duration_s']
        while True:
            if time.monotonic() - started >= self.shakedown_timeout:
                raise DeploymentError('Shakedown timed out; no PASS was recorded.')
            for key in ('scenario', 'scenario_source'):
                if key in state: d[key] = state[key]
            if 'ai_cost' in state:
                d['ai_cost'] = {k: cost_before.get(k, 0) + state['ai_cost'].get(k, 0) for k in ('calls', 'input_tokens', 'output_tokens', 'krw')}
                # 원화는 시운전이 소수 둘째 자리로 보내므로 더한 뒤에도 같은 자리로 맞춘다(0.1+0.2가 0.30000000000000004가 되지 않게).
                d['ai_cost']['krw'] = round(d['ai_cost']['krw'], 2)
            steps = state.get('steps', [])
            attempt['steps'] = prior + steps
            attempt['duration_s'] = spent + time.monotonic() - started
            self.save(d)
            if state.get('status') == 'failed':
                raise DeploymentError('Shakedown failed (baseline unavailable or scenario failed); inspect runner logs and recorded steps.')
            if state.get('status') == 'done':
                verdict = state.get('verdict', {})
                result = verdict.get('status')
                expected = len(d.get('scenario', {}).get('steps', []))
                if not expected or len(steps) != expected or result not in VERDICT_RANK:
                    raise DeploymentError('Incomplete or invalid shakedown result; no PASS was recorded.')
                if any(step.get('local', {}).get('status') != 'passed' for step in steps):
                    raise DeploymentError('Baseline did not pass; comparison cannot be promoted.')
                if result in {'PASS', 'WARN'} and any(step.get('cloud', {}).get('status') != 'passed' or step.get('severity') == 'critical' for step in steps):
                    raise DeploymentError('Shakedown verdict contradicts its evidence; no PASS was recorded.')
                return verdict, state.get('report')
            if state.get('status') != 'running':
                raise DeploymentError('Unknown shakedown state; no PASS was recorded.')
            time.sleep(self.poll_seconds)
            state = self.shakedown.call('GET', '/shakedowns/' + id)

    def close(self):
        self.pool.shutdown(wait=True)
