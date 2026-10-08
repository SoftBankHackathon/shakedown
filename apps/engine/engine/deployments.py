"""Local-only orchestration. Never fabricates a shakedown verdict."""
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
from pydantic import Field
from typing import Literal

TERMINAL = {'deployed', 'promoted', 'blocked', 'failed'}

class DeployRequest(Model):
    shakedown: bool = False
    autofix: bool = False
    targets: list[Literal['local']] = Field(default_factory=lambda: ['local'], min_length=1, max_length=1)
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

    def build(self, project, image):
        with self.source(project.repo) as root:
            # Re-analyze the actual checkout, rather than trusting an earlier branch revision.
            analysis = RepoAnalyzer().analyze(str(root))
            manifest = next((e.file for e in analysis.evidence if e.field == 'stack' and e.file), None)
            context = (root / manifest).parent.resolve() if manifest else root
            if not context.is_relative_to(root) or not (context / 'Dockerfile').is_file():
                raise DeploymentError('The analyzed application needs a Dockerfile in its application directory.')
            if analysis.database not in {'postgres', 'postgresql'}:
                raise DeploymentError('This local integration currently requires the PostgreSQL sample application.')
            self.command(['docker', 'build', '-t', image, str(context)], 900)
            return analysis

    def call(self, method, path, body=None):
        try:
            with httpx.Client(timeout=20, trust_env=False) as client:
                response = client.request(method, self.base + path, json=body)
                response.raise_for_status()
                return response.json() if response.content else None
        except (httpx.HTTPError, ValueError):
            raise DeploymentError('Local Target request failed; check the service on 127.0.0.1:9101 and its deployment logs.') from None

class DeploymentStore:
    def __init__(self, path: Path, runner=None, poll_seconds=1, timeout=300):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.runner = runner or LocalRunner()
        self.poll_seconds, self.timeout = poll_seconds, timeout
        self.pool = ThreadPoolExecutor(max_workers=2)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, payload TEXT)')
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS active_project ON deployments(project_id) WHERE status NOT IN ('deployed','promoted','blocked','failed')")
            rows = db.execute("SELECT payload FROM deployments WHERE status NOT IN ('deployed','promoted','blocked','failed')").fetchall()
            for row in rows:
                d = json.loads(row[0]); d.update(status='failed', finished=time.time(), error='Engine restarted during deployment. Inspect Local Target resources before retrying.')
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
        if request.shakedown or request.autofix:
            raise DeploymentError('Shakedown and autofix are not connected. Disable both to deploy locally.')
        if 'local' not in project.targets:
            raise DeploymentError('Project must include the local target.')
        opts = {'replicas': 1, 'sticky_sessions': False, 'tz': 'Asia/Seoul'}
        if set(request.options) - {'local'}:
            raise DeploymentError('Only local target options are supported.')
        opts.update(request.options.get('local', {}))
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(opts['tz'])
        except (ZoneInfoNotFoundError, TypeError, ValueError):
            raise DeploymentError('Invalid timezone.') from None
        if set(opts) != {'replicas','sticky_sessions','tz'} or opts['replicas'] != 1 or opts['sticky_sessions'] is not False:
            raise DeploymentError('Local deployment supports one replica without sticky sessions.')
        d = dict(id='dep_' + uuid.uuid4().hex, project_id=project.id, created=time.time(), status='queued',
                 shakedown=False, autofix=False, options={'local': opts}, targets={'local': {'status':'pending','label':'Local Docker'}},
                 attempts=[], timings={}, ai_cost=dict(calls=0,input_tokens=0,output_tokens=0,krw=0))
        try:
            with self.connect() as db:
                db.execute('INSERT INTO deployments VALUES (?,?,?,?)', (d['id'], project.id, d['status'], json.dumps(d)))
        except sqlite3.IntegrityError:
            raise Busy('A deployment is already running for this project.') from None
        self.pool.submit(self.run, project, json.loads(json.dumps(d)))
        return d

    def run(self, project, d):
        submitted = False
        try:
            d['status'] = 'building'; self.save(d)
            start = time.monotonic()
            image = 'shakedown/engine:' + d['id']
            analysis = self.runner.build(project, image)
            d['image'] = image; d['timings']['build_s'] = time.monotonic() - start
            d['status'] = 'deploying'; d['targets']['local']['status'] = 'deploying'; self.save(d)
            start = time.monotonic()
            body = dict(deployment_id=d['id'], project_id=project.id, image=image, port=analysis.port,
                        health_path=analysis.health_path, database={'engine':'postgres','name':analysis.database_name or 'board_db'},
                        secret_refs={'SPRING_DATASOURCE_PASSWORD':'db_password'}, options=d['options']['local'])
            # Mark before POST: a transport timeout may follow a successful server-side acceptance.
            submitted = True
            self.runner.call('POST', '/deployments', body)
            while time.monotonic() - start < self.timeout:
                state = self.runner.call('GET', '/deployments/' + d['id'])
                if state.get('status') == 'failed': raise DeploymentError('Local Target deployment failed; inspect its logs.')
                if state.get('status') == 'ready':
                    from urllib.parse import urlsplit
                    url = urlsplit(state.get('url', ''))
                    if url.scheme != 'https' or not (url.hostname or '').endswith('.trycloudflare.com'):
                        raise DeploymentError('Local Target returned an invalid public URL.')
                    d['targets']['local'] = {k:v for k,v in state.items() if k in {'status','url','instances','info'}}
                    d['targets']['local']['label'] = 'Local Docker'
                    d['timings']['deploy_s'] = time.monotonic() - start
                    d['status'] = 'deployed'
                    break
                time.sleep(self.poll_seconds)
            else: raise DeploymentError('Local deployment readiness timed out.')
        except Exception as exc:
            d['status'] = 'failed'
            d['error'] = str(exc) if isinstance(exc, DeploymentError) else 'Deployment failed; inspect the local engine environment.'
            d['targets']['local'].update(status='failed', error=d['error'])
            if submitted:
                try: self.runner.call('DELETE', '/deployments/' + d['id'])
                except Exception: d['error'] += ' Cleanup failed; inspect Local Target before retrying.'
        finally:
            d['finished'] = time.time(); d['timings']['total_s'] = d['finished'] - d['created']; self.save(d)

    def close(self):
        self.pool.shutdown(wait=True)
