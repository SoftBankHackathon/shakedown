# Engine — Local / AWS 배포 + HTTP 시운전 연결

Action에서 프로젝트 분석 → Docker 빌드 → Local Target → 공개 URL → 선택적 HTTP 시운전 → 판정/보고서 표시를 실행합니다. 기존 baseline/candidate URL만 비교하는 기능도 있습니다. 김태현님의 PR #6–#9 구현을 호출하며, 엔진에서 별도 판정 로직이나 Playwright 시나리오를 만들지 않습니다.

## 실행

Python 3.12+, Node 22.18+ 또는 23.6+, Git, Docker가 필요합니다. 저장소 루트에서:

```sh
python3 -m venv apps/engine/.venv
apps/engine/.venv/bin/pip install -r apps/engine/requirements.txt
npm ci --ignore-scripts
```

각각 별도 터미널에서 실행합니다.

```sh
# infra/local/README.md에 따라 LOCAL_DB_PASSWORD 설정
node --env-file=infra/local/.env infra/local/server.mjs

# 기본 검증은 유료 AI 호출 없이 규칙 보고서 사용
SHAKEDOWN_AI_REPORT=off npm start -w @shakedown/shakedown

# 단일 worker. 공유 SQLite에 여러 엔진을 띄우지 않음
apps/engine/.venv/bin/uvicorn engine.api:app --app-dir apps/engine --host 127.0.0.1 --port 8700

npm run dev:web:live
```

Windows에서는 `.venv/Scripts/python.exe -m uvicorn`을 사용합니다. AI 보고서 설정은 `apps/shakedown/README.md`를 따릅니다. AI 보고서는 판정을 변경하지 않습니다.

[대시보드](http://localhost:3700)에 `samples/kty-board`를 입력합니다.

- 비교 URL을 비우고 Action: 로컬 배포만 실행, `deployed`(시운전 미실행).
- 비교 URL을 넣고 Action: 새 로컬 배포를 baseline으로 기존 URL과 비교.
- 프로젝트 화면에서 baseline과 비교 URL을 넣고 **기존 두 환경 비교**: 빌드/배포 없이 HTTP 시운전만 실행.
- 시운전은 회원가입·로그인·글쓰기·댓글을 실제로 수행합니다. 테스트 전용 환경 두 개를 사용하세요. 테스트 데이터는 자동 삭제하지 않습니다.
- `dev:web:live`는 `/engine` 프록시로 8700에 연결. 엔진 URL 없이 `npm run dev:web`로 실행하면 fixture 데모입니다.

## 지원 범위와 상태 의미

| 상태 | 의미 |
|---|---|
| `deployed` | 선택한 대상 배포 완료, 검사 미실행 |
| `promoted` | HTTP 시나리오 PASS. 실제 트래픽 전환/프로덕션 승격 아님 |
| `warned` | WARN. 증거 검토 필요 |
| `blocked` | BLOCKED 검사 게이트. 기존 URL의 접속을 차단하지 않음 |
| `failed` | 빌드/인프라/시운전 오류, 기준 환경 실패, 불완전 결과 등. PASS 없음 |

`release_gate`는 passed/review/blocked이며 관리 AWS 대상의 DELETE가 차단을 확인한 경우에만 `traffic_blocked=true`입니다. 정리된 대상은 `status=stopped`, 실패한 정리는 `cleanup=failed`로 표시합니다. `targets[*].status=external`은 사용자가 제공한 기존 환경입니다. 그 환경의 배포·삭제·트래픽 차단은 엔진이 관리하지 않습니다. 자동수정은 거절하며 보고서의 fix는 제안만 표시합니다.

**AWS 엔진 연결:** 아래 설정을 준비하면 ECR 업로드/digest 공유 → AWS Target 호출을 실행합니다. 실제 AWS 계정에서의 배포 검증은 아직 수행하지 않았습니다. 스택 생성·DB 초기화·사용자별 AWS 계정 연결은 자동화하지 않습니다.

## API

- `POST /api/projects`: repo, 선택적 name/targets로 분석·등록
- `GET /api/projects`, `GET /api/projects/{id}`: 프로젝트 조회
- `POST /api/projects/{id}/deployments`: 202 비동기 Local / AWS 배포
- `POST /api/projects/{id}/comparisons`: 202 기존 URL 비교
- `GET /api/deployments?project_id=...`, `GET /api/deployments/{id}`: 결과/증거 조회
- `GET /api/deployments/{id}/events`: SSE. 상태 또는 완료 단계 수 변화 후 전체 조회. 재연결 시 현재 상태부터, 과거 이벤트 재생 없음
- `GET /api/health`: 엔진 상태

배포 요청 예시:

```json
{"targets":["local"],"shakedown":true,"autofix":false,"comparison":{"name":"candidate","url":"https://candidate.example.com"},"options":{}}
```

비교만 실행:

```json
{"baseline":{"name":"local","url":"http://127.0.0.1:18080"},"candidate":{"name":"candidate","url":"https://candidate.example.com"}}
```

서로 다른 이름/URL이 필요합니다. HTTP(S) origin만 허용하며 자격 증명·경로·쿼리·fragment는 거절합니다. 같은 서비스의 별칭인지까지는 판단하지 않으므로 실제로 독립된 환경인지 확인하세요. 같은 프로젝트에서 배포/비교가 실행 중이면 409입니다. 단일 대상의 shakedown=true는 comparison이 필수이고, Local+AWS는 shakedown=true를 사용하며 autofix=true는 400입니다.

## 배포·장애 처리

- 로컬 경로 또는 공개 GitHub HTTPS 저장소, 분석된 앱 디렉터리의 Dockerfile을 우선 사용하며, 없으면 지원 스택의 규칙 기반 템플릿을 생성합니다. 이 모노레포는 `samples/kty-board` 경로 사용.
- 실제 checkout을 재분석합니다. Dockerfile 코드를 실행하므로 신뢰하는 저장소만 사용하세요.
- 로컬 배포는 PostgreSQL 샘플용: replicas=1, sticky_sessions=false. DB 비밀번호는 Local Target의 `db_password` secret reference 사용. 프로파일별 env 자동 전달은 미지원.
- Local은 배포마다 새 이미지/Compose 스택/볼륨을 만듭니다. AWS는 기존 ECS 서비스와 RDS를 재사용합니다. 기존 DB를 이어 쓰는 업데이트와 성공 배포 자동 정리는 미지원.
- 빌드 900초, Local readiness 300초, 시운전 폴링 180초, 개별 HTTP 요청 20초 제한. 시운전 서비스 자체 마감 시간에는 진행 중 HTTP/접속 재시도를 취소합니다. 이미 접수된 쓰기를 되돌리지는 않습니다.
- 배포/비교 중 예외가 나면 이번 요청으로 접수한 관리 대상들을 DELETE 시도합니다. 기존 외부 대상은 삭제하지 않습니다. BLOCKED에서는 관리 AWS 대상의 로그를 조회한 뒤 DELETE하여 공개 403/태스크 종료를 확인합니다. Local은 유지하며 WARN은 삭제하지 않습니다. 로그 본문은 엔진에 복제하지 않고 AWS 어댑터 기록에 보존합니다. Local Target DELETE는 진단 로그·DB 볼륨을 보존합니다.
- 재시작 시 미완료 기록은 failed로 전환. 자동 재실행하지 않습니다. SQLite 기록은 `apps/engine/.data`에 저장됩니다.
- 엔진/Target/Shakedown 서비스는 loopback에 유지합니다. 엔진은 localhost/127.0.0.1:3700 Origin만 허용하고 내부 호출은 9101/9102/9201로 고정됩니다. 이는 프로덕션 인증 체계가 아닙니다.

## 검증

```sh
apps/engine/.venv/bin/python -m pytest apps/engine/tests -q
npm test -w @shakedown/shakedown
npm run build:web
npm run lint:web
```

실제 컨테이너 통합 재현은 `docs/integration-audit-2026-10-08.md`를 참고하세요. 정적 분석은 단순 manifest/annotation 기반이며 실행 시 설정을 확정하지 않습니다. PASS는 실행한 HTTP 시나리오에만 해당하며 브라우저 JS 동작·보안·AWS 운영 적합성을 보장하지 않습니다.


## AWS 연결 설정 (기존 팀 스택)

AWS CLI, Docker Buildx, Node 24가 필요합니다. `infra/aws/README.md` 절차대로 계정/스택/권한/DB 스키마를 먼저 준비합니다. 이 기능은 현재 Spring Boot + PostgreSQL 샘플 계약을 대상으로 하며 범용 AWS 프로비저닝 기능이 아닙니다.

1. 먼저 `POST /api/projects`로 레포를 등록하고 반환된 `id`를 확인합니다. 기존 레포면 같은 ID를 반환합니다.
2. AWS 설정 생성 시 그 ID를 `projectId`로 사용합니다. 한 스택은 한 프로젝트 전용이며, 기존 상태 DB를 다른 프로젝트에 재연결하면 안 됩니다.
3. 엔진과 AWS 어댑터에 같은 `AWS_ADAPTER_CONFIG` 절대 경로를 지정하고, 엔진에만 `HACKATHON_PUBLISH_PROFILE`(ECR 업로드 named profile)을 지정합니다. AWS 키를 웹 입력값/레포에 넣지 않습니다. 어댑터는 설정의 별도 `profile`을 사용합니다.
4. `npm run dev:aws`와 엔진을 각각 실행합니다. Local을 함께 선택한다면 Local 어댑터도 실행합니다.
5. 첫 화면 또는 프로젝트 화면에서 AWS를 선택합니다. 단독 선택은 배포만, Local+AWS는 같은 digest 이미지로 배포 후 HTTP 비교를 실행합니다. 외부 비교 URL은 단일 대상에서만 사용합니다.

```json
{"targets":["aws"],"shakedown":false,"autofix":false,"options":{}}
```

```json
{"targets":["local","aws"],"shakedown":true,"autofix":false,"options":{"aws":{"replicas":2,"sticky_sessions":false,"tz":"UTC"}}}
```

AWS 빌드는 linux/amd64 단일 manifest이며 한 번 빌드하여 ECR에 업로드합니다. 반환된 digest를 인증 중 로컬 Docker에 pull하여 두 대상에 같은 주소를 전달합니다. ECR 토큰은 임시 Docker 설정에만 쓰고 삭제합니다. 설정·계정·프로젝트·포트·DB가 다르면 배포를 거절합니다. 기존 DB 스키마가 없으면 먼저 AWS bootstrap 절차를 완료해야 합니다.

BLOCKED의 AWS 정리는 앱 공개 경로와 ECS 태스크만 중지합니다. ALB/RDS/ECR 등은 남으므로 비용도 남습니다. 실제 계정에서 ECR push, ECS readiness, ALB 403, RDS 연결은 별도 검증해야 합니다.

## AI API 연결과 Dockerfile 자동 생성

실제 모드 첫 화면의 **배포 없이 이미지 먼저 만들기**는 프로젝트 등록만 수행하고 이미지 계획 화면으로 이동합니다. 배포/Cloudflare 공개/ECR 업로드는 수행하지 않습니다.

1. API 키 없이도 **빌드 계획 생성**으로 지원 스택의 Dockerfile을 생성할 수 있습니다. 기존 Dockerfile이 있으면 우선 사용합니다.
2. 선택적으로 상단 **API 설정**(`/settings`)에서 Claude 모델 ID와 키를 입력하고 **연결 테스트 후 적용**을 실행합니다. 테스트는 짧은 유료 Messages 요청을 보냅니다. 키는 서버 메모리에만 보관하고 응답·로그·SQLite·브라우저 저장소에 저장하지 않습니다. 재시작하면 UI 입력 키는 사라집니다.
3. 환경변수로 연결할 때는 엔진 프로세스에 `ANTHROPIC_API_KEY`, `ENGINE_CLAUDE_MODEL`을 설정합니다. 이 설정은 기존 시운전 보고서 서비스와 별개입니다. 연결 해제는 현재 엔진 메모리만 비우며 환경변수 자체는 변경하지 않습니다.
4. 규칙 생성 실패 시에만 연결된 Claude를 한 번 자동 호출해 Dockerfile을 생성합니다. 파일명·의존성 이름·실행 대상 등 추출 정보만 전송하며 원본 코드/README/환경변수 값은 보내지 않습니다. 공식 베이스 이미지·COPY 경로·최종 비root USER·실행 명령 구조를 검증합니다. 이는 보안 샌드박스나 앱 실행 성공 보장이 아닙니다. 연결이 없거나 생성/검증이 실패하면 중단하며, 빌드 실패를 이유로 API를 재호출하지 않습니다.
5. 생성 결과를 확인한 뒤 **확인한 계획으로 이미지 빌드**를 누릅니다. 준비한 소스 복사본으로 Docker 이미지를 만들며 원본 레포를 수정하지 않습니다. 결과는 `shakedown/generated:img_...` 태그입니다. **built는 이미지 생성 성공이며 앱 실행/DB 연결/실제 배포는 별도**입니다.

지원 범위:
- Spring Boot Gradle: Wrapper 포함, Java 17/21, 단일 bootJar.
- Spring Boot Maven: Java 17/21, 단일 실행 가능 JAR 프로젝트.
- Node Express/Next.js: npm start 및 package-lock.json 필수, Node 22/24. npm workspaces/pnpm/Yarn 등은 AI fallback 또는 기존 Dockerfile 사용.
- FastAPI: requirements.txt에 uvicorn 명시, Python 3.12/3.13. `main:app` 등 실제 최상위 FastAPI 인스턴스 감지/입력.
- 다른 단일 앱 스택은 이미지 전용 등록(`image_only: true`) 후 AI fallback을 시도합니다. 정보가 부족하거나 검증에 실패하면 Dockerfile 수동 작성이 필요합니다. 템플릿은 멀티서비스 아키텍처나 DB를 생성하지 않습니다.

컨텍스트 복사는 `.git`, `.env*`, 개인키 파일, 자격증명 파일, 빌드 캐시/산출물, 심볼릭 링크를 제외하며 파일 10,000개/200MB로 제한합니다. 소스에 하드코딩된 비밀까지 검출하는 기능은 아닙니다. 기존 Dockerfile이 제외된 산출물에 의존하면 이미지 계획 빌드는 실패할 수 있습니다. 빌드 명령은 소스의 스크립트를 실행하므로 신뢰하는 레포만 사용합니다.

계획과 빌드 상태는 단일 엔진 프로세스에 보관합니다. 최근 계획 최대 8개를 유지하고 이전 미실행 계획은 제거하며, 엔진 재시작 후 계획을 다시 생성해야 합니다. 빌드 완료/실패/정상 종료 시 소스 복사본을 제거합니다. 비정상 종료 후 `.data/image-plans` 정리는 운영자가 수행합니다. 이미지는 사용자 Docker에 남습니다. 자동 재시도·실행 검증·이미지 자동 삭제는 하지 않습니다.

기존 Local/AWS Action도 Dockerfile이 없으면 동일한 **규칙 우선 → AI fallback** 생성기를 사용합니다. 현재 배포 어댑터의 PostgreSQL 샘플 제한은 그대로입니다. 별도 이미지 화면에서 선택한 AI/런타임 계획은 Action에 자동 적용되지 않으며, Action은 최신 소스를 다시 분석·빌드합니다.

API:
- `GET /api/settings/llm`: 키 없는 연결 상태
- `POST /api/settings/llm/connect`: `{model, api_key?}` 테스트 후 메모리에 적용
- `POST /api/settings/llm/disconnect`: 연결 해제
- `POST /api/projects/{id}/image-plans`: `{use_ai?: true, runtime?, entrypoint?}` (기본 true, false로 자동 API 호출 금지)
- `POST /api/projects/{id}/image-plans/{plan_id}/build`: 검토한 계획 비동기 빌드(202)
- `GET /api/image-builds/{id}`: queued/building/built/failed

이 UI는 기존 loopback 전용 엔진의 개발용 설정 화면입니다. 공개 멀티유저 서비스용 인증·사용자별 키 격리·영구 Secret Store는 이번 구현 범위가 아닙니다.


### Fallback 프롬프트 규격

`engine/image_prompt.py`에서 고정 지침과 `dockerfile-fallback.v1` 요청 형식을 관리합니다. 규칙 검사 중 **처음 중단된 원인**을 엔진이 진단하며, 실제 Docker 빌드 로그를 분석한 결과나 전체 문제 목록은 아닙니다. 오류 문장을 다시 파싱하지 않고 각 규칙이 코드와 상세 정보를 생성합니다.

- `failure`: code, stage (`rule_generation`), message, details (누락 파일/의존성, 요청·지원 런타임, 실행 후보 등)
- `project`: 제한된 파일 목록, 스택, 포트, 실행 대상, 의존성·스크립트 이름
- `constraints`: 검증기와 공유하는 허용 지시문/공식 이미지, COPY·USER·명령 제약
- `response_schema`: 정확히 `{"dockerfile": "..."}` 또는 `{"dockerfile": null}`

진단 코드는 `UNSUPPORTED_STACK`, `UNSUPPORTED_RUNTIME`, `MISSING_GRADLE_WRAPPER`, `INVALID_MANIFEST`, `MISSING_START_SCRIPT`, `UNSUPPORTED_PACKAGE_LAYOUT`, `MISSING_LOCKFILE`, `MISSING_DEPENDENCY_MANIFEST`, `UNRESOLVED_ENTRYPOINT`, `ENTRYPOINT_MISMATCH`, `MISSING_RUNTIME_DEPENDENCY`, `UNREADABLE_BUILD_INPUT`입니다.

예: npm lockfile 누락 시 `failure.code=MISSING_LOCKFILE`, `failure.details={"missing_files":["package-lock.json"],"package_manager":"npm"}`을 전달합니다. 고정 지침은 누락 파일을 있다고 가정하거나 임의의 의존성/실행 대상을 만들지 말고, 근거가 부족하면 null을 반환하도록 요구합니다. 이 지침 준수와 실제 앱 동작을 정적 검사만으로 보장하지는 않습니다. 원본 코드/README/환경값/명령 로그는 요청에 넣지 않습니다.

계획 응답에 `fallback_diagnostic`과 `prompt_version`을 포함해 어떤 진단과 규격으로 생성했는지 확인할 수 있습니다. 프롬프트 본문이나 키를 별도 로그로 저장하지 않습니다.

## AWS 아키텍처 판단 (설계 계획, 배포 적용 전)

프로젝트 화면에서 서비스 형태, 피크 RPS, 가용성, 트래픽 변화, 우선순위를 입력해 세 설계안을 비교합니다. 저장소를 다시 분석해 프레임워크/DB/서버 세션/의존성 이름과 README의 제한된 키워드를 추출합니다. README 원문이나 코드·환경값은 API로 전송하지 않습니다. README 키워드는 미검증 힌트이며 실제 기능이나 수요의 증명이 아닙니다.

| 설계안 | 태스크당 자원 | 태스크 / AZ | 확장 | 관계형 DB 필요 시 |
| --- | --- | --- | --- | --- |
| small | 0.5 vCPU / 1 GiB | 1 / 1 | 고정 | Single-AZ RDS |
| medium | 1 vCPU / 2 GiB | 2–4 / 2 | 목표 추적 | Multi-AZ RDS |
| large | 2 vCPU / 4 GiB | 3–12 / 3 | 목표 추적 | Multi-AZ RDS, 읽기 복제본 검토 |

세 안은 ALB + ECS Fargate HTTP 서비스의 초기 설계 프리셋입니다. 수치는 AWS 처리량 보장이 아닙니다. 피크 10 RPS 이하/100 이하/100 초과로 초기 후보를 나누는 **제품 내 가정**이며 반드시 부하 테스트로 조정해야 합니다. 고가용성 또는 급증 트래픽은 최소 medium을 요구합니다. 코드 크기로 수요를 추측하지 않으며, RPS/가용성/트래픽 미정이면 잠정 추천만 반환하고 선택 저장을 막습니다. 비용 견적은 제공하지 않습니다.

Claude가 연결되어 있고 `use_ai=true`이면 `aws-architecture.v1` 고정 요청(카탈로그·근거·운영 요구·규칙 최소 등급·허용안·응답 스키마)을 한 번 전송합니다. AI는 `template_id`, 한국어 `reasons`, 실제 `evidence_ids`만 반환할 수 있습니다. 임의 리소스/명령/새 템플릿이나 최소 등급 미달 선택은 거절합니다. 미연결 또는 use_ai=false이면 규칙 결과임을 명시합니다. API 오류나 규격 위반을 AI 성공으로 대체하지 않습니다.

로컬 DB/파일 영속성 위험 또는 지원 밖 DB는 선택을 차단합니다. 감지된 서버 세션은 다중 태스크 전 앱 수정 검토 항목으로 표시합니다. 정적 사이트/워커/배치 및 미확정 서비스는 HTTP 세 안에 억지로 배치하지 않고 별도 설계 필요로 반환합니다. 캐시·큐·읽기 복제본을 규모만으로 추가하지 않습니다.

계획 및 선택은 `architecture.sqlite3`에 저장되어 재시작 후에도 남습니다. 프로젝트가 다른 계획이나 최신이 아닌 계획은 선택할 수 없습니다. 저장된 근거는 작성 당시의 스냅샷이며 레포/요구가 바뀌면 다시 판단해야 합니다.

- POST `/api/projects/{id}/architecture-plans`: ArchitectureRequest
- GET `/api/projects/{id}/architecture-plans/latest`: 최근 계획 또는 null
- POST `/api/projects/{id}/architecture-plans/{plan_id}/select`: `{template_id: small|medium|large}`

**선택 저장은 인프라 생성이나 배포 설정 적용이 아닙니다.** `deployment.ready=false`로 반환합니다. 현재 AWS 데모 어댑터는 고정 CPU/메모리, 준비된 ALB/RDS, 최대 2태스크 계약을 사용합니다. 이 계획을 실제 배포하려면 템플릿별 IaC/어댑터 연결, HTTPS·네트워크·DB·부하 검증을 별도로 구현해야 합니다. 기존 Action은 저장된 계획을 적용하지 않습니다. 유료 Claude 호출과 실제 AWS 배포는 테스트 대역으로 대체했으며 실제 검증하지 않았습니다.

설계 참고: [ECS 목표 추적 확장](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html), [ECS AZ 분산](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-rebalancing.html), [RDS Multi-AZ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html). Multi-AZ DB 인스턴스의 standby는 읽기 트래픽을 처리하지 않습니다.
### Security Gate prerequisite (#16)

Image planning now scans an isolated repository snapshot using the merged
`apps/security-gate/main.py --with-gitleaks` (schema 3.0), before rule generation
or an LLM call. Secret files are included in this scan, then excluded from the
Docker build context. Local and AWS builds, including existing Dockerfiles,
use the same checked snapshot path; saved image plans are checked again before
Docker executes. Only `ALLOW` proceeds. `DENY`, `REVIEW`, `SCAN_FAILED`, missing
scanner tools, invalid output and timeouts stop the operation. There is no
request flag or LLM fallback that overrides this gate.

Install the Security Gate's Semgrep/Gitleaks tools as described in
`apps/security-gate/README.md`; the engine Python environment also needs its
requirements. The current gate supports Compose privileged checks, limited
Python patterns and text-secret detection, not all-language vulnerability
analysis. Missing applicable checks remain REVIEW; unsupported/binary inputs
can fail scanning. In particular, Java/Gradle samples are not automatically
approved. Tool installation alone does not make unsupported projects pass.
Only a sanitized decision is returned; raw scanner findings/output are not
sent to the dashboard or LLM. No production security guarantee is implied.
