"""Explicit, language-independent contract for one HTTP container."""
import re
from typing import Literal
from pydantic import Field, model_validator
from engine.models import Model

NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$')
SENSITIVE = re.compile(r'password|passwd|secret|token|credential|api.?key|private.?key|access.?key', re.I)

class RuntimeDatabase(Model):
    mode: Literal['none', 'postgres', 'external'] = 'none'
    name: str = Field(default='app', pattern=r'^[a-z][a-z0-9_]{0,62}$')
    bindings: dict[str, Literal['host','port','name','username','password','jdbc_url','postgres_url']] = Field(default_factory=dict)

class HttpRuntime(Model):
    version: Literal['http-runtime.v1'] = 'http-runtime.v1'
    port: int = Field(ge=1,le=65535)
    health_path: str = Field(default='/',max_length=256,pattern=re.compile(r'^/(?!/)[^\s?#\\]*$'))
    env: dict[str,str] = Field(default_factory=dict,max_length=64)
    secret_refs: dict[str,str] = Field(default_factory=dict,max_length=32)
    database: RuntimeDatabase = Field(default_factory=RuntimeDatabase)
    init_command: list[str] = Field(default_factory=list,max_length=32)

    @model_validator(mode='after')
    def validate_contract(self):
        groups=[self.env,self.secret_refs,self.database.bindings]
        names=[key for group in groups for key in group]
        if len(names)!=len(set(names)) or any(not NAME.fullmatch(key) or key in {'PORT','TZ'} for key in names):
            raise ValueError('Invalid, overlapping or reserved environment variable names')
        if any(SENSITIVE.search(k) or len(v)>4096 or '\x00' in v or re.search(r'://[^/\s]*@',v) for k,v in self.env.items()):
            raise ValueError('Use secret references for credentials')
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',v) for v in self.secret_refs.values()):
            raise ValueError('Use an adapter-registered secret name, not a secret value or ARN')
        if self.database.mode!='postgres' and self.database.bindings:
            raise ValueError('Managed DB bindings require postgres mode')
        if self.database.mode=='postgres' and not {'password','postgres_url'} & set(self.database.bindings.values()):
            raise ValueError('Map a password or postgres_url environment variable for PostgreSQL')
        if self.database.mode=='external' and not self.secret_refs:
            raise ValueError('External DB requires adapter-registered connection secrets')
        if self.database.mode=='none' and self.init_command:
            raise ValueError('Initialization requires a database')
        if any(not arg or len(arg)>512 or '\x00' in arg or '\n' in arg for arg in self.init_command):
            raise ValueError('Invalid initialization argv')
        return self


def database_conflict(mode, detected):
    """Static detection is evidence, not automatic database conversion."""
    if mode == 'none' and detected:
        return 'DB 없음 설정과 감지된 DB가 충돌합니다. DB 설정 또는 소스를 확인하세요.'
    if mode == 'postgres' and detected and detected not in {'postgres', 'postgresql'}:
        return '관리형 PostgreSQL 설정과 감지된 DB가 다릅니다. DB 변환은 자동 수행하지 않습니다.'
    return None
