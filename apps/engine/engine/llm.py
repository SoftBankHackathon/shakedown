"""Optional Claude connection. Keys never appear in API responses or persistence."""
import json
import os
import threading
import httpx
from pydantic import Field, SecretStr
from engine.models import Model


class LlmError(ValueError):
    pass


class ConnectionRequest(Model):
    model: str = Field(min_length=1, max_length=128, pattern=r'^[a-zA-Z0-9_.:-]+$')
    api_key: SecretStr | None = None


class LlmConnection:
    def __init__(self, transport=None):
        self.lock = threading.Lock()
        self.key = os.environ.get('ANTHROPIC_API_KEY', '')
        self.model = os.environ.get('ENGINE_CLAUDE_MODEL', '')
        self.source = 'environment' if self.key else 'none'
        self.verified = False
        self.transport = transport

    def status(self):
        with self.lock:
            return dict(provider='anthropic', configured=bool(self.key and self.model), model=self.model,
                        verified=self.verified, source=self.source)

    def credentials(self):
        with self.lock: return self.key, self.model

    def message(self, key, model, prompt, max_tokens=512):
        if not key or not model:
            raise LlmError('API 설정에서 Claude 키와 모델을 연결하세요.')
        try:
            with httpx.Client(timeout=25, trust_env=False, transport=self.transport) as client:
                response = client.post('https://api.anthropic.com/v1/messages',
                    headers={'x-api-key': key, 'anthropic-version': '2023-06-01'},
                    json={'model': model, 'max_tokens': max_tokens, 'messages':[{'role':'user', 'content':prompt}]})
                if response.status_code in (401,403): raise LlmError('Claude 인증 또는 권한 오류입니다. 키와 모델 접근 권한을 확인하세요.')
                if response.status_code == 429: raise LlmError('Claude 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.')
                if response.status_code >= 400: raise LlmError('Claude 요청 실패입니다. 모델 이름·계정 잔액을 확인하세요.')
                data=response.json()
                if data.get('stop_reason') == 'max_tokens': raise LlmError('Claude 응답이 잘렸습니다. 수동 설정을 사용하세요.')
                result=''.join(x.get('text','') for x in data.get('content',[]) if x.get('type')=='text')
                if not result.strip(): raise LlmError('Claude가 빈 응답을 반환했습니다.')
                return result
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
            if isinstance(exc,LlmError): raise
            raise LlmError('Claude 연결에 실패했습니다. 네트워크와 API 설정을 확인하세요.') from None

    def connect(self, request):
        old_key,_=self.credentials()
        key=request.api_key.get_secret_value().strip() if request.api_key else old_key
        if len(key)>4096 or '\n' in key or '\r' in key: raise LlmError('API 키 형식이 올바르지 않습니다.')
        self.message(key,request.model,'Reply with OK. This is a connection test.',64)
        with self.lock:
            self.key,self.model,self.verified=key,request.model,True
            if request.api_key: self.source='memory'
        return self.status()

    def disconnect(self):
        with self.lock:
            self.key,self.model,self.source,self.verified='','','none',False
        return self.status()

    def suggest(self, request):
        from engine.image_prompt import render_prompt
        key,model=self.credentials()
        prompt=render_prompt(request)
        text=self.message(key,model,prompt,2400)
        try:
            data=json.loads(text)
            if not isinstance(data,dict) or set(data)!={'dockerfile'} or (data['dockerfile'] is not None and not isinstance(data['dockerfile'],str)): raise ValueError()
            return data
        except (ValueError,TypeError): raise LlmError('Claude 제안을 해석할 수 없습니다. 수동 설정을 사용하세요.') from None
