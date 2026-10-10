"""Local and pre-provisioned AWS orchestration. Never fabricates a shakedown verdict."""
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
    targets: list[Literal['local', 'aws']] = Field(default_factory=lambda: ['local'], min_length=1, max_length=2)
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
    def __init__(self, path: Path, runner=None, poll_seconds=1, timeout=300, shakedown=None, shakedown_timeout=180, aws=None):
        self.shakedown = shakedown or ShakedownClient()
        self.shakedown_timeout = shakedown_timeout
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.runner = runner or LocalRunner()
        from engine.aws_runner import AwsRunner
        self.aws = aws or AwsRunner()
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
        targets = [name for name in ('local', 'aws') if name in request.targets]
        if len(targets) != len(request.targets):
            raise DeploymentError('Targets must be unique.')
        if request.comparison and (len(targets) != 1 or request.comparison.name in targets):
            raise DeploymentError('An external comparison requires one deployed target and a distinct name.')
        if request.shakedown != (request.comparison is not None or len(targets) == 2):
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
            opts = {'replicas': 1 if target == 'local' else 2, 'sticky_sessions': False, 'tz': 'Asia/Seoul' if target == 'local' else 'UTC'}
            opts.update(request.options.get(target, {}))
            try:
                ZoneInfo(opts['tz'])
            except (ZoneInfoNotFoundError, TypeError, ValueError):
                raise DeploymentError('Invalid timezone.') from None
            if (set(opts) != {'replicas','sticky_sessions','tz'} or type(opts['replicas']) is not int
                    or opts['replicas'] not in ([1] if target == 'local' else [1, 2]) or opts['sticky_sessions'] is not False):
                raise DeploymentError('Local supports one replica; AWS supports one or two. Sticky sessions are unsupported.')
            if target == 'aws' and architecture:
                opts['replicas'] = architecture['min_tasks']
            options[target] = opts
        if 'aws' in targets:
            self.aws.preflight(project)
            if architecture: self.aws.validate_architecture(architecture, project)
        d = dict(id='dep_' + uuid.uuid4().hex, project_id=project.id, created=time.time(), status='queued',
                 shakedown=request.shakedown, autofix=False, options=options, targets={name: {'status':'pending','label': 'Local Docker' if name == 'local' else 'AWS ECS'} for name in targets},
                 architecture=architecture, architecture_plan_id=request.architecture_plan_id, attempts=[], timings={}, ai_cost=dict(calls=0,input_tokens=0,output_tokens=0,krw=0))
        try:
            with self.connect() as db:
                db.execute('INSERT INTO deployments VALUES (?,?,?,?)', (d['id'], project.id, d['status'], json.dumps(d)))
        except sqlite3.IntegrityError:
            raise Busy('A deployment is already running for this project.') from None
        self.pool.submit(self.run, project, json.loads(json.dumps(d)), request.comparison)
        return d

    def cleanup(self, d, targets):
        for target in reversed(targets):
            runner = self.aws if target == 'aws' else self.runner
            if target == 'aws':
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
                if target == 'aws': d['traffic_blocked'] = True
            except Exception:
                d['targets'][target]['cleanup'] = 'failed'
                d['targets'][target]['status'] = 'failed'
                d['error'] = d.get('error', '') + f' {target} cleanup failed; inspect the adapter and retry DELETE.'
                if target == 'aws': d['traffic_blocked'] = False

    def run(self, project, d, comparison=None):
        submitted = []
        try:
            d['status'] = 'building'; self.save(d)
            start = time.monotonic()
            image = 'shakedown/engine:' + d['id']
            if 'aws' in d['targets']:
                analysis, image = self.aws.build_publish(project, d['id'])
            else:
                analysis = self.runner.build(project, image)
            d['image'] = image; d['timings']['build_s'] = time.monotonic() - start
            d['status'] = 'deploying'; self.save(d)
            start = time.monotonic()
            for target in d['targets']:
                runner = self.aws if target == 'aws' else self.runner
                d['targets'][target]['status'] = 'deploying'; self.save(d)
                body = dict(deployment_id=d['id'], project_id=project.id, image=image, port=analysis.port,
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
            baseline = next(iter(d['targets']))
            if len(d['targets']) == 2:
                comparison = Endpoint(name='aws', url=d['targets']['aws']['url'])
            if comparison:
                self.compare(d, Endpoint(name=baseline, url=d['targets'][baseline]['url']), comparison, project)
                if d['status'] == 'blocked' and 'aws' in submitted:
                    self.cleanup(d, ['aws'])
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
            self.compare(d, request.baseline, request.candidate, project)
        except Exception as exc:
            d['status'] = 'failed'
            d['error'] = str(exc) if isinstance(exc, DeploymentError) else 'Comparison failed; no PASS was recorded.'
        finally:
            d['finished'] = time.time(); d['timings']['total_s'] = d['finished'] - d['created']; self.save(d)

    def compare(self, d, baseline, candidate, project):
        if baseline.url == candidate.url:
            raise DeploymentError('Cannot compare an environment with itself.')
        # Registered URLs are existing environments. Never deploy/delete someone else's resources.
        for target in (baseline, candidate):
            if target.name not in d['targets']:
                d['targets'][target.name] = dict(status='external', label='Existing environment (not managed by engine)', url=target.url)
        d['status'] = 'shakedown'
        d['attempts'] = [dict(n=1, options=d['options'], steps=[])]
        self.save(d)
        body = dict(deployment_id=d['id'], project_id=project.id, baseline=baseline.model_dump(),
                    candidates=[candidate.model_dump()], hints={'uses_server_session': project.analysis.uses_server_session})
        started = time.monotonic()
        state = self.shakedown.call('POST', '/shakedowns', body)
        id = state.get('shakedown_id', '')
        import re
        if not re.fullmatch(r'sd_[a-zA-Z0-9]+', id):
            raise DeploymentError('Invalid shakedown ID returned by runner.')
        d['shakedown_id'] = id
        while True:
            if time.monotonic() - started >= self.shakedown_timeout:
                raise DeploymentError('Shakedown timed out; no PASS was recorded.')
            attempt = d['attempts'][0]
            for key in ('scenario', 'scenario_source', 'ai_cost'):
                if key in state: d[key] = state[key]
            attempt['steps'] = state.get('steps', [])
            attempt['duration_s'] = time.monotonic() - started
            self.save(d)
            if state.get('status') == 'failed':
                raise DeploymentError('Shakedown failed (baseline unavailable or scenario failed); inspect runner logs and recorded steps.')
            if state.get('status') == 'done':
                verdict = state.get('verdict', {})
                result = verdict.get('status')
                steps = attempt['steps']
                expected = len(d.get('scenario', {}).get('steps', []))
                if not expected or len(steps) != expected or result not in {'PASS', 'WARN', 'BLOCKED'}:
                    raise DeploymentError('Incomplete or invalid shakedown result; no PASS was recorded.')
                if any(step.get('local', {}).get('status') != 'passed' for step in steps):
                    raise DeploymentError('Baseline did not pass; comparison cannot be promoted.')
                if result in {'PASS', 'WARN'} and any(step.get('cloud', {}).get('status') != 'passed' or step.get('severity') == 'critical' for step in steps):
                    raise DeploymentError('Shakedown verdict contradicts its evidence; no PASS was recorded.')
                attempt['verdict'] = verdict
                attempt['report'] = state.get('report')
                d['status'] = {'PASS':'promoted', 'WARN':'warned', 'BLOCKED':'blocked'}[result]
                d['release_gate'] = 'blocked' if result == 'BLOCKED' else 'review' if result == 'WARN' else 'passed'
                d['traffic_blocked'] = False
                return
            if state.get('status') != 'running':
                raise DeploymentError('Unknown shakedown state; no PASS was recorded.')
            time.sleep(self.poll_seconds)
            state = self.shakedown.call('GET', '/shakedowns/' + id)

    def close(self):
        self.pool.shutdown(wait=True)
