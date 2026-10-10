"""Bounded facts for LLM fallback and structural Dockerfile validation (not a sandbox)."""
import ast
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex

from engine.image_builder import BuildError, excluded, read

BASES = {'node','python','eclipse-temurin','maven','gradle','golang','rust','ruby','nginx','alpine','debian','ubuntu','php','composer','busybox'}
ALLOWED = {'FROM','WORKDIR','COPY','RUN','ENV','ARG','USER','EXPOSE','CMD','ENTRYPOINT','LABEL'}


def build_facts(context, analysis, options):
    # No source text, README, script bodies or env values are sent to the provider.
    files=[]
    for visited, (directory, dirs, names) in enumerate(os.walk(context, followlinks=False)):
        if visited>=5000: break
        dirs[:]=sorted(d for d in dirs if not excluded(d) and not (Path(directory)/d).is_symlink())
        for name in sorted(names):
            path=Path(directory)/name
            if not excluded(name) and not path.is_symlink():
                files.append(path.relative_to(context).as_posix())
            if len(files)>=300: break
        if len(files)>=300: break
    facts=dict(stack=analysis.stack,port=analysis.port,runtime=options.runtime or analysis.java_version,
               requested_entrypoint=options.entrypoint,files=files)
    manifest=context/'package.json'
    if manifest.is_file():
        try:
            data=json.loads(read(manifest))
            facts['npm']={key:sorted(data.get(key,{}))[:100] for key in ('scripts','dependencies','devDependencies') if isinstance(data.get(key,{}),dict)}
        except (BuildError,ValueError,TypeError,AttributeError): pass
    requirements=context/'requirements.txt'
    if requirements.is_file():
        facts['python_dependencies']=re.findall(r'(?m)^([A-Za-z][A-Za-z0-9_.-]*)',read(requirements))[:100]
    apps=[]
    for name in files:
        if not name.endswith('.py') or len(apps)>=20: continue
        try: tree=ast.parse(read(context/name))
        except (BuildError,SyntaxError): continue
        for node in tree.body:
            if isinstance(node,ast.Assign) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id in {'Flask','FastAPI'}:
                apps.extend({'module':name[:-3].replace('/','.'),'name':target.id,'framework':node.value.func.id} for target in node.targets if isinstance(target,ast.Name))
    facts['python_apps']=apps
    return facts


def validate_dockerfile(value, context):
    if not isinstance(value,str) or not value.strip() or len(value)>20000 or '\x00' in value:
        raise BuildError('AI가 유효한 Dockerfile을 생성하지 못했습니다. 실행 정보나 Dockerfile을 직접 보완하세요.')
    if re.search(r'(?mi)^\s*#\s*(syntax|escape|check)\s*=',value) or '`' in value or '<<' in value:
        raise BuildError('AI Dockerfile의 파서 지시문/복합 구문은 지원하지 않습니다.')
    logical=re.sub(r'\\\s*\n',' ',value)
    stages=set();current_stages=set();stage_count=0;user=None;command=False
    for raw in logical.splitlines():
        line=raw.strip()
        if not line or line.startswith('#'): continue
        parts=line.split(None,1)
        if len(parts)!=2 or parts[0].upper() not in ALLOWED: raise BuildError('AI Dockerfile에 지원하지 않는 지시문이 있습니다.')
        instruction,body=parts[0].upper(),parts[1]
        if instruction=='FROM':
            match=re.fullmatch(r'(?:--platform=\$BUILDPLATFORM\s+)?([a-z0-9-]+):([A-Za-z0-9_.-]+)(?:\s+[Aa][Ss]\s+([a-zA-Z0-9_-]+))?',body)
            if not match or match[1] not in BASES: raise BuildError('AI Dockerfile의 베이스 이미지는 태그가 있는 허용된 공식 이미지를 사용해야 합니다.')
            stages.update(current_stages)
            current_stages={str(stage_count)};stage_count+=1
            if match[3]:
                if match[3] in stages: raise BuildError("AI Dockerfile 스테이지 이름이 중복됩니다.")
                current_stages.add(match[3])
            user=None;command=False
            continue
        if not stage_count: raise BuildError('AI Dockerfile은 FROM으로 시작해야 합니다.')
        if instruction=='RUN' and body.startswith('--'): raise BuildError('AI Dockerfile 빌드 권한/마운트 옵션은 지원하지 않습니다.')
        if instruction=='COPY':
            source_stage=None
            while body.startswith('--'):
                option,sep,body=body.partition(' ')
                if not sep: raise BuildError('AI COPY 형식 오류입니다.')
                if option.startswith('--from='): source_stage=option.split('=',1)[1]
                elif not re.fullmatch(r'--chown=[a-zA-Z0-9_:-]+|--chmod=0?[0-7]{3}',option): raise BuildError('AI COPY 옵션을 확인하세요.')
                body=body.lstrip()
            try: paths=json.loads(body) if body.startswith('[') else shlex.split(body)
            except (ValueError,TypeError): raise BuildError('AI COPY 형식 오류입니다.') from None
            if not isinstance(paths,list) or len(paths)<2 or any(not isinstance(p,str) for p in paths): raise BuildError('AI COPY 경로 오류입니다.')
            if source_stage is not None:
                if source_stage not in stages: raise BuildError('AI COPY가 선언되지 않은 빌드 스테이지를 참조합니다.')
            else:
                for source in paths[:-1]:
                    path=PurePosixPath(source)
                    if path.is_absolute() or '..' in path.parts or '$' in source or any(excluded(p) for p in path.parts): raise BuildError('AI COPY가 허용되지 않은 소스를 참조합니다.')
                    matches=list(context.glob(source)) if source!='.' else [context]
                    if not matches or any(p.is_symlink() or not p.resolve().is_relative_to(context.resolve()) for p in matches): raise BuildError('AI COPY 소스가 없거나 저장소 밖을 가리킵니다.')
        if instruction=='USER': user=body
        if instruction in {'CMD','ENTRYPOINT'}:
            try: args=json.loads(body)
            except ValueError: raise BuildError('AI 실행 명령은 JSON 배열이어야 합니다.') from None
            if not isinstance(args,list) or not args or any(not isinstance(x,str) for x in args): raise BuildError('AI 실행 명령 형식 오류입니다.')
            command=True
    if not stage_count or not command or not user or not re.fullmatch(r'[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?',user) or (user.split(':')[0]=='root' or (user.split(':')[0].isdigit() and int(user.split(':')[0])==0)):
        raise BuildError('AI Dockerfile 최종 단계에 비root USER와 실행 명령이 필요합니다.')
    return value.rstrip()+'\n'
