"""Reviewed image plans and isolated builds. No deployment or registry push here."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import ast
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import uuid

from pydantic import Field
from engine.models import Model
from engine.analyzer import ImageRepoAnalyzer

class BuildError(ValueError):
    pass

class RuleFailure(BuildError):
    """Machine-readable local diagnosis; never includes file contents or process logs."""
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.diagnostic = dict(code=code, stage='rule_generation', message=message, details=details)


class PlanRequest(Model):
    use_ai: bool = True
    runtime: str | None = Field(default=None,max_length=16)
    entrypoint: str | None = Field(default=None,max_length=120)

IGNORE = {'.git','.venv','venv','node_modules','__pycache__','.data','.next','.gradle','build','target','dist'}
SECRET_NAMES = {'.npmrc','.pypirc','.netrc','credentials','id_rsa','id_ed25519'}

def excluded(name):
    return name in IGNORE or name in SECRET_NAMES or name.startswith('.env') or name.endswith(('.pem','.key','.p12','.pfx'))


def app_context(root, analysis):
    manifest=next((e.file for e in analysis.evidence if e.field=='stack' and e.file),None)
    context=(root/manifest).parent if manifest else root
    if not context.resolve().is_relative_to(root.resolve()): raise BuildError('앱 경로가 저장소 밖을 가리킵니다.')
    if any(p.is_symlink() for p in [context,*context.parents] if p.is_relative_to(root)):
        raise BuildError('링크된 앱 경로는 지원하지 않습니다.')
    return context


def read(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size>1_000_000:
        raise BuildError('빌드 설정 파일을 안전하게 읽을 수 없습니다.')
    try: return path.read_text(encoding='utf-8')
    except (OSError,UnicodeError): raise BuildError('빌드 설정 파일을 읽을 수 없습니다.') from None


def python_apps(root):
    found=[]
    for path in sorted(root.glob('*.py')) + sorted(root.glob('*/*.py')):
        if len(found)>10: break
        if excluded(path.parent.name) or path.parent.is_symlink(): continue
        try: tree=ast.parse(read(path))
        except (BuildError,SyntaxError): continue
        for node in tree.body:
            if isinstance(node,ast.Assign) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='FastAPI':
                for target in node.targets:
                    if isinstance(target,ast.Name): found.append(path.relative_to(root).with_suffix('').as_posix().replace('/','.')+':'+target.id)
    return found


def rule_plan(context, analysis, options=None):
    options=options or PlanRequest()
    if (context/'Dockerfile').exists():
        return dict(source='existing',template='existing',dockerfile=read(context/'Dockerfile'),warnings=['기존 Dockerfile을 사용합니다. 저장소 코드는 빌드 중 실행됩니다.'])
    stack=analysis.stack
    template= {'spring-boot-gradle':'spring-gradle','spring-boot-maven':'spring-maven','express':'node-npm','nextjs':'node-npm','fastapi':'fastapi'}.get(stack)
    if not template: raise RuleFailure('UNSUPPORTED_STACK', '감지된 스택에 대응하는 규칙 템플릿이 없습니다.', detected_stack=stack)
    version=options.runtime or (str(analysis.java_version) if analysis.java_version else None)
    entry=options.entrypoint
    warnings=[]
    source='rule'
    port=analysis.port
    if template.startswith('spring-'):
        version=version or '21'
        if version not in {'17','21'}: raise RuleFailure('UNSUPPORTED_RUNTIME', '현재 Java 17 또는 21 템플릿을 지원합니다. 런타임을 확인하세요.', runtime='java', requested=version, supported=['17','21'])
        if template=='spring-gradle':
            missing=[path for path in ('gradlew','gradle/wrapper/gradle-wrapper.jar','gradle/wrapper/gradle-wrapper.properties')
                     if not (context/path).is_file() or (context/path).is_symlink()]
            if missing: raise RuleFailure('MISSING_GRADLE_WRAPPER', 'Gradle Wrapper 파일이 필요합니다.', missing_files=missing)
            build=f'FROM --platform=$BUILDPLATFORM eclipse-temurin:{version}-jdk AS build\nWORKDIR /src\nCOPY . .\nRUN chmod +x gradlew && ./gradlew --no-daemon bootJar\nRUN mkdir /out && find build/libs -maxdepth 1 -name "*.jar" ! -name "*-plain.jar" -exec cp {{}} /out/ \\; && test "$(find /out -name "*.jar" | wc -l)" -eq 1 && mv /out/*.jar /app.jar\n'
        else:
            build=f'FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-{version} AS build\nWORKDIR /src\nCOPY . .\nRUN mvn -B -DskipTests package\nRUN mkdir /out && find target -maxdepth 1 -name "*.jar" ! -name "*-sources.jar" ! -name "*-javadoc.jar" -exec cp {{}} /out/ \\; && test "$(find /out -name "*.jar" | wc -l)" -eq 1 && mv /out/*.jar /app.jar\n'
        dockerfile=build+f'FROM eclipse-temurin:{version}-jre\nWORKDIR /app\nCOPY --from=build --chown=10001:10001 /app.jar /app/app.jar\nUSER 10001:10001\nEXPOSE {port}\nENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-jar", "/app/app.jar"]\n'
    elif template=='node-npm':
        version=version or '22'
        if version not in {'22','24'}: raise RuleFailure('UNSUPPORTED_RUNTIME', 'Node 런타임은 22 또는 24를 선택하세요.', runtime='node', requested=version, supported=['22','24'])
        try: package=json.loads(read(context/'package.json'))
        except (ValueError,TypeError): raise RuleFailure('INVALID_MANIFEST', 'package.json을 읽을 수 없습니다.', file='package.json') from None
        if not isinstance(package,dict) or not isinstance(package.get('scripts',{}),dict):
            raise RuleFailure('INVALID_MANIFEST', 'package.json 객체 형식을 확인하세요.', file='package.json')
        if not package.get('scripts',{}).get('start'): raise RuleFailure('MISSING_START_SCRIPT', 'package.json에 start 스크립트가 필요합니다.', file='package.json', required_script='start')
        if package.get('workspaces') or (context/'pnpm-lock.yaml').exists() or (context/'yarn.lock').exists(): raise RuleFailure('UNSUPPORTED_PACKAGE_LAYOUT', '워크스페이스·pnpm·Yarn은 규칙 템플릿에서 지원하지 않습니다.', workspaces=bool(package.get('workspaces')), lockfiles=[name for name in ('pnpm-lock.yaml','yarn.lock') if (context/name).is_file()])
        if not (context/'package-lock.json').is_file(): raise RuleFailure('MISSING_LOCKFILE', '재현 가능한 npm 빌드를 위해 package-lock.json이 필요합니다.', missing_files=['package-lock.json'], package_manager='npm')
        dockerfile=f'FROM node:{version}-bookworm-slim\nWORKDIR /app\nCOPY --chown=node:node . .\nRUN npm ci && npm run build --if-present && chown -R node:node /app\nENV NODE_ENV=production\nENV PORT={port}\nUSER node\nEXPOSE {port}\nCMD ["npm", "start"]\n'
    else:
        version=version or '3.12'
        if version not in {'3.12','3.13'}: raise RuleFailure('UNSUPPORTED_RUNTIME', 'Python 런타임은 3.12 또는 3.13을 선택하세요.', runtime='python', requested=version, supported=['3.12','3.13'])
        if not (context/'requirements.txt').is_file(): raise RuleFailure('MISSING_DEPENDENCY_MANIFEST', 'FastAPI 템플릿에는 requirements.txt가 필요합니다.', missing_files=['requirements.txt'])
        choices=python_apps(context)
        if not entry and len(choices)==1: entry=choices[0]
        if not entry or not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*',entry): raise RuleFailure('UNRESOLVED_ENTRYPOINT', 'FastAPI 실행 대상을 지정하세요. 예: main:app', candidates=choices, requested=entry)
        if entry not in choices: raise RuleFailure('ENTRYPOINT_MISMATCH', '실제 FastAPI 인스턴스와 일치하는 실행 대상을 지정하세요.', candidates=choices, requested=entry)
        requirements=read(context/'requirements.txt')
        if not re.search(r'(?mi)^uvicorn(?:\[.*?\])?\s*(?:[=<>~!]|$)',requirements): raise RuleFailure('MISSING_RUNTIME_DEPENDENCY', 'requirements.txt에 uvicorn을 추가하세요.', file='requirements.txt', missing_dependencies=['uvicorn'])
        dockerfile=f'FROM python:{version}-slim\nWORKDIR /app\nCOPY . .\nRUN pip install --no-cache-dir -r requirements.txt\nENV PYTHONDONTWRITEBYTECODE=1\nENV PYTHONUNBUFFERED=1\nUSER 10001:10001\nEXPOSE {port}\nCMD '+json.dumps(['python','-m','uvicorn',entry,'--host','0.0.0.0','--port',str(port)])+'\n'
    warnings+=['이미지 빌드 성공은 앱 실행·DB 연결 성공을 뜻하지 않습니다. 배포 시 별도 헬스체크를 확인하세요.', '빌드에는 저장소의 스크립트가 실행됩니다. 신뢰하는 저장소를 사용하세요.']
    if not options.runtime: warnings.append(f'런타임 {version}을 선택했습니다. 프로젝트 요구 버전과 일치하는지 확인하세요.')
    return dict(source=source,template=template,runtime=version,entrypoint=entry or '',dockerfile=dockerfile,warnings=warnings)


def make_plan(context, analysis, options=None, llm=None):
    options = options or PlanRequest()
    try:
        return rule_plan(context, analysis, options)
    except BuildError as exc:
        # Do not replace an existing file that was unreadable/linked with an AI guess.
        if (context / 'Dockerfile').exists() or (context / 'Dockerfile').is_symlink():
            raise
        if not options.use_ai or llm is None:
            raise BuildError(f'{exc} 규칙으로 생성하지 못했습니다. API 설정에서 Claude를 연결하면 자동으로 보완합니다.') from None
        from engine.docker_fallback import build_facts, validate_dockerfile
        facts = build_facts(context, analysis, options)
        from engine.image_prompt import build_request
        diagnostic = getattr(exc, 'diagnostic', dict(code='UNREADABLE_BUILD_INPUT', stage='rule_generation',
                                                      message=str(exc), details={}))
        request = build_request(facts, diagnostic)
        suggestion = llm.suggest(request)
        dockerfile = validate_dockerfile(suggestion.get('dockerfile'), context)
        return dict(source='ai-fallback', template='llm', dockerfile=dockerfile,
                    fallback_reason=str(exc), fallback_diagnostic=diagnostic, prompt_version=request['schema_version'], warnings=[
                        '규칙으로 생성하지 못해 Claude를 1회 호출했습니다.',
                        'Dockerfile 구문·빌드 정책 검사를 통과했습니다. 실행 안전성이나 앱 동작을 보장하는 검사는 아닙니다.',
                        '생성 내용을 검토한 뒤 신뢰하는 소스만 빌드하세요. 이미지 생성과 앱 실행 검증은 별개입니다.'])


def snapshot(source,destination, *, security=False):
    destination.mkdir(parents=True,exist_ok=True,mode=0o700)
    count=total=0
    for directory,dirs,files in os.walk(source,followlinks=False):
        dirs[:]=[d for d in dirs if not (d == '.git' if security else excluded(d)) and not (Path(directory)/d).is_symlink()]
        for name in files:
            path=Path(directory)/name
            if (name == '.git' if security else excluded(name)) or path.is_symlink(): continue
            size=path.stat().st_size
            count+=1;total+=size
            if count>10000 or total>200_000_000: raise BuildError('빌드 컨텍스트가 제한(파일 10,000개/200MB)을 초과했습니다.')
            target=destination/path.relative_to(source)
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(path,target)


@contextmanager
def checked_source(root):
    from engine.security import require_allow
    with tempfile.TemporaryDirectory(prefix='shakedown-security-') as directory:
        staged=Path(directory)/'source'
        # Scan secrets too, before excluding them from the Docker context.
        snapshot(root,staged,security=True)
        report=require_allow(staged)
        yield staged,report


@contextmanager
def prepared(context,analysis,options=None,llm=None,security_root=None):
    root=security_root or context
    with checked_source(root) as (repository, report):
        source=repository/context.relative_to(root)
        plan=make_plan(source,analysis,options,llm)
        plan['security_gate']=report
        with tempfile.TemporaryDirectory(prefix='shakedown-image-') as directory:
            staged=Path(directory)/'context'; snapshot(source,staged)
            (staged/'Dockerfile').write_text(plan['dockerfile'])
            yield staged,plan


class ImageBuilder:
    def __init__(self,root,llm,runner):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        self.llm=llm;self.runner=runner;self.plans={};self.jobs={};self.lock=threading.Lock()
        self.pool=ThreadPoolExecutor(max_workers=1)

    def plan(self,project,options):
        with self.runner.source(project.repo) as root:
            with checked_source(root) as (source,report):
                analysis=ImageRepoAnalyzer().analyze(str(source))
                context=app_context(source,analysis)
                plan=make_plan(context,analysis,options,self.llm)
                plan['security_gate']=report
                id='img_'+uuid.uuid4().hex
                dest=self.root/id
                try:
                    snapshot(context,dest)
                    (dest/'Dockerfile').write_text(plan['dockerfile'])
                except Exception:
                    shutil.rmtree(dest,ignore_errors=True);raise
        plan.update(id=id,project_id=project.id,port=analysis.port,build_status='not_built')
        with self.lock:
            while len(self.plans) >= 8:
                oldest=next((key for key in self.plans if self.jobs.get(key,{}).get('status') not in {'queued','building'}),None)
                if oldest is None: break
                self.plans.pop(oldest)
                shutil.rmtree(self.root/oldest,ignore_errors=True)
            self.plans[id]=plan
        return plan

    def build(self,project,id):
        with self.lock:
            plan=self.plans.get(id)
            if not plan or plan['project_id']!=project.id: raise BuildError('빌드 계획이 없거나 만료됐습니다. 먼저 다시 생성하세요.')
            if id in self.jobs: return dict(self.jobs[id])
            if any(x['status'] in {'queued','building'} for x in self.jobs.values()): raise BuildError('이미지 빌드가 진행 중입니다. 완료 후 다시 시도하세요.')
            job=dict(id=id,project_id=project.id,status='queued',image='shakedown/generated:'+id,source=plan['source'])
            self.jobs[id]=job
        self.pool.submit(self.run,id)
        return dict(job)

    def run(self,id):
        with self.lock:
            job=self.jobs[id];job['status']='building';image=job['image']
        result={'status':'built'}
        try:
            from engine.security import require_allow
            job['security_gate']=require_allow(self.root/id)
            self.runner.command(['docker','build','-t',image,str(self.root/id)],900)
        except BuildError as exc:
            result={'status':'failed','error':str(exc)}
        except Exception:
            result={'status':'failed','error':'이미지 빌드 실패. Docker 실행 상태와 빌드 계획을 확인하세요. 원본 명령 출력은 비밀 보호를 위해 노출하지 않습니다.'}
        finally:
            shutil.rmtree(self.root/id,ignore_errors=True)
            with self.lock: job.update(result)

    def get(self,id):
        with self.lock: return dict(self.jobs[id]) if id in self.jobs else None

    def close(self):
        self.pool.shutdown(wait=True)
        for id in self.plans: shutil.rmtree(self.root/id,ignore_errors=True)
