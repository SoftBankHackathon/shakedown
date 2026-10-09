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

- 로컬 경로 또는 공개 GitHub HTTPS 저장소, 분석된 앱 디렉터리의 Dockerfile 필요. 이 모노레포는 `samples/kty-board` 경로 사용.
- 실제 checkout을 재분석합니다. Dockerfile 코드를 실행하므로 신뢰하는 저장소만 사용하세요.
- 로컬 배포는 PostgreSQL 샘플용: replicas=1, sticky_sessions=false. DB 비밀번호는 Local Target의 `db_password` secret reference 사용. 프로파일별 env 자동 전달은 미지원.
- Local은 배포마다 새 이미지/Compose 스택/볼륨을 만듭니다. AWS는 기존 ECS 서비스와 RDS를 재사용합니다. 기존 DB를 이어 쓰는 업데이트와 성공 배포 자동 정리는 미지원.
- 빌드 900초, Local readiness 300초, 시운전 폴링 180초, 개별 HTTP 요청 20초 제한. 시운전 서비스 자체 마감 시간에는 진행 중 HTTP/접속 재시도를 취소합니다. 이미 접수된 쓰기를 되돌리지는 않습니다.
- 배포/비교 중 예외가 나면 이번 요청으로 접수한 관리 대상들을 DELETE 시도합니다. 기존 외부 대상은 삭제하지 않습니다. BLOCKED에서는 관리 AWS 대상의 로그를 조회한 뒤 DELETE하여 공개 403/태스크 종료를 확인합니다. Local은 유지하며 WARN은 삭제하지 않습니다. 로그 본문은 엔진에 복제하지 않고 AWS 어댑터 기록에 보존합니다. Local Target DELETE는 진단 로그·DB 볼륨을 보존합니다.
- 재시작 시 미완료 기록은 failed로 전환. 자동 재실행하지 않습니다. SQLite 기록은 `apps/engine/.data`에 저장됩니다.
- 엔진/Target/Shakedown 서비스는 loopback에 유지합니다. 엔진은 localhost/127.0.0.1:3700 Origin만 허용하고 내부 호출은 9101/9102/9103(GCP)/9104/9201로 고정됩니다. 이는 프로덕션 인증 체계가 아닙니다.

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

## Azure 연결 설정 (기존 팀 스택)

`infra/azure/README.md` 절차(Bicep 준비, 스키마 초기화)를 먼저 마칩니다. 엔진과 Azure 어댑터에 같은 `AZURE_ADAPTER_CONFIG` 절대 경로를 지정하고, `az login`은 해커톤 구독으로 합니다(설정의 구독과 다르면 배포를 거절합니다).

- Azure만 선택: linux/amd64로 한 번 빌드해 ACR에 올리고 그 digest로 배포합니다.
- AWS와 함께 선택: AWS가 ECR에 올린 이미지를 digest 그대로 ACR로 복사합니다(`docker buildx imagetools create`). 복사에는 `HACKATHON_PUBLISH_PROFILE`도 필요합니다.
- 옵션: replicas 1~2, `sticky_sessions`는 Azure만 허용(Container Apps ingress 세션 고정).
- 시운전: 시운전 API가 비교 대상을 하나씩만 받으므로, 첫 대상(Local 선택 시 Local)을 기준으로 클라우드마다 한 번씩 실행합니다. 결과 행은 `candidate`로 구분되고, 판정은 가장 나쁜 결과(BLOCKED > WARN > PASS)입니다. BLOCKED가 나온 클라우드만 로그 수집 후 DELETE합니다.
