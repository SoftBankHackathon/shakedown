"""Dashboard-facing API. Actual deployments and shakedown are team-owned."""
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from engine.analyzer import AnalysisError
from engine.models import CreateProjectRequest, Project
from engine.projects import DATA_DIR, ProjectStore


def create_app(store: ProjectStore | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(api: FastAPI):
        if api.state.store is None:
            api.state.store = ProjectStore(DATA_DIR / 'projects.sqlite3')
        yield

    api = FastAPI(title='Shakedown Engine', version='0.1.0', lifespan=lifespan)
    api.state.store = store
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
        return found

    # The live dashboard loads this list immediately after importing a repo.
    @api.get('/api/deployments')
    def deployments(project_id: str | None = None):
        return []

    @api.post('/api/projects/{project_id}/deployments')
    def deploy(project_id: str):
        if api.state.store.get(project_id) is None:
            raise HTTPException(status_code=404, detail='Project not found.')
        raise HTTPException(status_code=501, detail='Deployment orchestration is not connected. No build, deploy, shakedown or autofix was performed.')

    return api


app = create_app()
