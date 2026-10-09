"""Python mirrors of the read-only team contracts."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictStr

TargetName = Literal['local', 'aws', 'onprem', 'gcp', 'azure']

class Model(BaseModel):
    model_config = ConfigDict(extra='forbid')

class Evidence(Model):
    field: str
    value: str
    file: str | None
    source: Literal['rule', 'ai', 'default']

class Route(Model):
    method: str
    path: str
    file: str
    params: list[str]

class Analysis(Model):
    stack: str
    port: int = Field(ge=1, le=65535)
    java_version: int | None
    database: str | None
    database_name: str | None
    health_path: str
    uses_server_session: bool
    summary: str
    routes: list[Route]
    evidence: list[Evidence]
    env: dict[str, str]
    secret_env: list[str]
    warnings: list[str]

class CostLedger(Model):
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    krw: float = 0.0

class Secret(Model):
    name: str
    value: Literal['••••••••'] = '••••••••'

class Project(Model):
    id: str
    name: str
    repo: str
    created: float
    analysis: Analysis
    analysis_cost: CostLedger = Field(default_factory=CostLedger)
    ports: dict[str, int] = Field(default_factory=dict)
    targets: list[TargetName]
    secrets: list[Secret]
    last_deployment: dict | None = None

class CreateProjectRequest(Model):
    image_only: bool = False
    repo: StrictStr = Field(min_length=1, max_length=4096)
    name: StrictStr | None = Field(default=None, min_length=1, max_length=120)
    targets: list[TargetName] = Field(default_factory=lambda: ['local', 'aws'], min_length=1)

# Internal compatibility types for the imported analyzer, never exposed by API.
class DatabaseConfig(Model):
    type: str | None = None
    required: bool = False

class DeployConfig(Model):
    repo_url: str
    framework: str | None = None
    runtime: str | None = None
    runtime_version: str | None = None
    build_tool: str | None = None
    port: int | None = None
    database: DatabaseConfig = Field(default_factory=DatabaseConfig)
    required_env_keys: list[str] = Field(default_factory=list)
    dockerfile: bool = False
    health_path: str | None = None
    warnings: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0, le=1)
