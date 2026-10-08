"""Dashboard-facing project and local deployment API."""
from contextlib import asynccontextmanager
import asyncio
import json
import time
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from engine.deployments import DeploymentStore, DeployRequest, CompareRequest, DeploymentError, Busy, TERMINAL
from engine.analyzer import AnalysisError
from engine.models import CreateProjectRequest, Project
from engine.projects import DATA_DIR, ProjectStore


def create_app(store: ProjectStore | None = None, deployments_store: DeploymentStore | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(api: FastAPI):
        if api.state.store is None:
            api.state.store = ProjectStore(DATA_DIR / 'projects.sqlite3')
        if api.state.deployments is None:
            api.state.deployments = DeploymentStore(api.state.store.path.parent / "deployments.sqlite3")
        yield
        api.state.deployments.close()

    api = FastAPI(title='Shakedown Engine', version='0.1.0', lifespan=lifespan)
    api.state.store = store
    api.state.deployments = deployments_store
    api.add_middleware(CORSMiddleware,
                       allow_origins=['http://localhost:3700', 'http://127.0.0.1:3700'],
                       allow_methods=['GET', 'POST', 'OPTIONS'], allow_headers=['Content-Type'])

    @api.exception_handler(RequestValidationError)
    async def invalid_request(_request, _exc):
        # Pydantic errors include raw input; never serialize them or log bodies.
        return JSONResponse(status_code=400, content={'detail': 'Invalid request body; check repo, name and targets.'})

    @api.get('/api/health')
    def health():
        return {'ok': True}

    @api.get('/api/projects', response_model=list[Project])
    def projects():
        return api.state.store.list()

    @api.post('/api/projects', response_model=Project)
    def create_project(body: CreateProjectRequest):
        try:
            return api.state.store.create(body)
        except AnalysisError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except Exception:
            raise HTTPException(status_code=500, detail='Repository analysis or storage failed; no repository contents were logged.') from None

    @api.get('/api/projects/{project_id}', response_model=Project)
    def project(project_id: str):
        found = api.state.store.get(project_id)
        if found is None:
            raise HTTPException(status_code=404, detail='Project not found.')
        history = api.state.deployments.list(project_id)
        found.last_deployment = history[0] if history else None
        return found

    @api.middleware('http')
    async def local_access(request: Request, call_next):
        if request.url.hostname not in {'localhost', '127.0.0.1', 'testserver'}:
            return JSONResponse(status_code=403, content={'detail': 'Loopback host required.'})
        origin = request.headers.get('origin')
        if origin and origin not in {'http://localhost:3700', 'http://127.0.0.1:3700'}:
            return JSONResponse(status_code=403, content={'detail': 'Origin not allowed.'})
        return await call_next(request)

    @api.get('/api/deployments')
    def deployments(project_id: str | None = None):
        return api.state.deployments.list(project_id)

    @api.post('/api/projects/{project_id}/deployments', status_code=202)
    def deploy(project_id: str, body: DeployRequest):
        project = api.state.store.get(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail='Project not found.')
        try:
            return api.state.deployments.start(project, body)
        except Busy as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except DeploymentError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    @api.post('/api/projects/{project_id}/comparisons', status_code=202)
    def compare(project_id: str, body: CompareRequest):
        found = api.state.store.get(project_id)
        if found is None:
            raise HTTPException(status_code=404, detail='Project not found.')
        try:
            return api.state.deployments.start_comparison(found, body)
        except Busy as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except DeploymentError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    @api.get('/api/deployments/{deployment_id}')
    def deployment(deployment_id: str):
        found = api.state.deployments.get(deployment_id)
        if found is None:
            raise HTTPException(status_code=404, detail='Deployment not found.')
        return found

    @api.get('/api/deployments/{deployment_id}/events')
    def events(deployment_id: str):
        deployment(deployment_id)
        async def stream():
            previous = None
            while True:
                d = api.state.deployments.get(deployment_id)
                status = d['status']
                progress = (status, len(d.get('attempts', [{}])[-1].get('steps', [])) if d.get('attempts') else 0)
                if progress != previous:
                    event = dict(ts=time.time(), kind='stage', status=status, message=status)
                    yield 'data: ' + json.dumps(event) + '\n\n'
                    yield 'data: ' + json.dumps(dict(ts=time.time(), kind='log', source='engine', line=status)) + '\n\n'
                    previous = progress
                if status in TERMINAL:
                    yield 'data: ' + json.dumps(dict(ts=time.time(), kind='done', status=status)) + '\n\n'
                    return
                yield ': keepalive\n\n'
                await asyncio.sleep(1)
        return StreamingResponse(stream(), media_type='text/event-stream', headers={'Cache-Control':'no-cache', 'X-Accel-Buffering':'no'})

    return api


app = create_app()
