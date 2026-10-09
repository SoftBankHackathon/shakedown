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

    def cleanup(self, d, targets):
        blocked = []
        for target in reversed(targets):
            runner = self.runner_for(target)
            if target in CLOUDS:
                try:
                    # Collect evidence before DELETE stops tasks. Do not persist raw application logs.
                    runner.call('GET', '/deployments/' + d['id'] + '/logs')
                    d['targets'][target]['logs_collected'] = True
                except Exception:
                    d['targets'][target]['logs_collected'] = False
            try:
                runner.call('DELETE', '/deployments/' + d['id'])
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
                runner = self.runner_for(target)
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
                runner.call('POST', '/deployments', body)
                deadline = time.monotonic() + (max(self.timeout, 2700) if target == 'aws' and d.get('architecture') else self.timeout)
                while time.monotonic() < deadline:
                    state = runner.call('GET', '/deployments/' + d['id'])
                    if state.get('status') == 'failed': raise DeploymentError(f'{target} deployment failed; inspect its logs.')
                    if state.get('status') == 'ready':
                        url = urlsplit(state.get('url', ''))
                        valid = (url.scheme == 'https' and (url.hostname or '').endswith('.trycloudflare.com')) if target == 'local' else runner.valid_url(state.get('url', ''))
                        if not valid: raise DeploymentError(f'{target} returned an invalid public URL.')
                        d['targets'][target].update({k:v for k,v in state.items() if k in {'status','url','instances','info'}})
                        self.save(d)
                        break
                    time.sleep(self.poll_seconds)
                else: raise DeploymentError(f'{target} deployment readiness timed out.')
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
        attempt = dict(n=1, options=d['options'], steps=[], duration_s=0)
        d['attempts'] = [attempt]
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
            for key in ('scenario', 'scenario_source', 'ai_cost'):
                if key in state: d[key] = state[key]
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
