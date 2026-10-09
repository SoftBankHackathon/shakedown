"""Persistent project import with canonical repo identity and atomic deduplication."""
from contextlib import closing, contextmanager
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from engine.analyzer import AnalysisError, RepoAnalyzer, ImageRepoAnalyzer
from engine.models import CreateProjectRequest, Project, Secret

WORKSPACE = Path(__file__).resolve().parents[3]
DATA_DIR = Path(__file__).resolve().parents[1] / '.data'


def normalize_repo(source: str) -> str:
    source = source.strip()
    if not source:
        raise AnalysisError('Repository source is required.')
    if '://' in source or source.startswith('git@'):
        url = RepoAnalyzer.github_url(source)
        if url.endswith('.git'):
            url = url[:-4]
        return url.lower()
    try:
        path = Path(source)
        if not path.is_absolute():
            path = WORKSPACE / path
        path = path.resolve(strict=True)
        if not path.is_dir():
            raise AnalysisError('Local repository source must be a directory.')
        return os.path.normcase(str(path))
    except (OSError, ValueError):
        raise AnalysisError('Local repository directory does not exist or is inaccessible.') from None


class ProjectStore:
    def __init__(self, path: Path, analyzer: RepoAnalyzer | None = None):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.analyzer = analyzer or RepoAnalyzer()
        self.lock = threading.Lock()
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, repo TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)')

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.path, timeout=30)) as db:
            with db:
                yield db

    def list(self) -> list[Project]:
        with self.connect() as db:
            rows = db.execute('SELECT payload FROM projects ORDER BY rowid DESC').fetchall()
        return [Project.model_validate_json(row[0]) for row in rows]

    def get(self, project_id: str) -> Project | None:
        with self.connect() as db:
            row = db.execute('SELECT payload FROM projects WHERE id = ?', (project_id,)).fetchone()
        return Project.model_validate_json(row[0]) if row else None

    def create(self, request: CreateProjectRequest) -> Project:
        if len(request.targets) != len(set(request.targets)):
            raise AnalysisError('Targets must be unique and contain at least one target.')
        if request.name is not None and not request.name.strip():
            raise AnalysisError('Project name must not be blank.')
        repo = normalize_repo(request.repo)
        # One import at a time in this process; UNIQUE repo also protects other workers.
        with self.lock:
            with self.connect() as db:
                row = db.execute('SELECT payload FROM projects WHERE repo = ?', (repo,)).fetchone()
            if row:
                return Project.model_validate_json(row[0])
            analysis = (ImageRepoAnalyzer() if request.image_only else self.analyzer).analyze(repo)
            name = request.name.strip() if request.name else repo.rstrip('/\\').replace('\\', '/').rsplit('/', 1)[-1]
            project = Project(id='prj_' + uuid.uuid4().hex[:16], name=name, repo=repo,
                              created=time.time(), analysis=analysis, targets=request.targets,
                              secrets=[Secret(name=key) for key in analysis.secret_env])
            with self.connect() as db:
                db.execute('INSERT OR IGNORE INTO projects (id, repo, payload) VALUES (?, ?, ?)',
                           (project.id, repo, project.model_dump_json()))
                row = db.execute('SELECT payload FROM projects WHERE repo = ?', (repo,)).fetchone()
            return Project.model_validate_json(row[0])
