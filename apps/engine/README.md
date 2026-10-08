# Engine — STEP 4 (2026-10-08)

Repo URL/로컬 경로를 정적으로 분석해 팀 공통 `Project`를 반환하는 API입니다.
코드를 실행하거나 빌드하지 않으며, Local/AWS 배포와 Shakedown 검사 구현은 각 담당자의 책임입니다.
공식 기준은 `packages/contracts/src/index.ts`, `openapi/engine.yaml`, `target.yaml`, `shakedown.yaml`입니다. 공통 Contracts와 다른 팀원 폴더는 수정하지 않았습니다.

## 설치 및 Windows 실행

Python **3.12 이상**, 공개 GitHub Repo 분석에는 Git 및 네트워크 접근이 필요합니다.
PowerShell에서 현재 Worktree 루트를 기준으로 실행합니다. 가상환경 활성화 없이도 실행할 수 있습니다.

```powershell
Set-Location apps/engine
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn engine.api:app --host 127.0.0.1 --port 8700
```

Swagger: `http://localhost:8700/docs`.
개발용 CORS는 `http://localhost:3700`, `http://127.0.0.1:3700`만 허용합니다.
Dashboard는 기존 루트 명령 `npm run dev:web:live` 또는 `NEXT_PUBLIC_API_URL=http://localhost:8700` 설정으로 연결할 수 있습니다. Engine에서 Web 파일을 수정하지 않습니다.

등록 데이터는 `apps/engine/.data/projects.sqlite3`에 저장합니다. GitHub clone 임시 파일, 테스트 임시 파일도 `apps/engine/.data` 안에만 생성됩니다.
상대 Repo 경로는 실행 위치와 무관하게 **Worktree 루트**를 기준으로 해석합니다. 예: `samples/kty-board`.

## API 테스트

서버 실행 후 다른 PowerShell 창에서:

```powershell
Invoke-RestMethod http://localhost:8700/api/health
$projectBody = @{
    repo = 'samples/kty-board'
    name = 'kty-board'
    targets = @('local', 'aws')
} | ConvertTo-Json
$projectResult = Invoke-RestMethod -Method Post -Uri http://localhost:8700/api/projects -ContentType 'application/json' -Body $projectBody
$projectResult.analysis | ConvertTo-Json -Depth 10
Invoke-RestMethod http://localhost:8700/api/projects
Invoke-RestMethod "http://localhost:8700/api/projects/$($projectResult.id)"
```

공개 GitHub URL도 `repo = 'https://github.com/OWNER/REPO'`로 등록합니다.
허용 형식은 GitHub HTTPS Repo URL입니다. 인증정보, query, fragment, SSH URL, 브랜치 하위 경로는 400으로 거절합니다. Clone은 depth=1, 60초 제한이며 Git hook/template/custom filter를 비활성화합니다. Repo 내부 코드는 실행하지 않습니다.

| API | 현재 동작 |
|---|---|
| `GET /api/health` | `200 {"ok": true}` |
| `GET /api/projects` | 최신 등록순 Project 배열 |
| `POST /api/projects` | `repo`, 선택적 `name`, `targets`를 받아 분석 후 200 Project |
| `GET /api/projects/{project_id}` | Project 상세, 없으면 404 |
| `GET /api/deployments` | Dashboard 초기 조회용 빈 배열. 배포 실행 기록이 없음 |
| `POST /api/projects/{project_id}/deployments` | 미연동 상태를 501로 명시. 없는 Project는 404 |

`targets`를 생략하면 OpenAPI 기본값 `[local, aws]`를 사용합니다. 최소 두 개의 서로 다른 공통 TargetName을 요구하고 입력 순서를 유지합니다. 첫 번째가 baseline입니다.
Repo identity는 GitHub 대소문자/`.git`/끝 `/`, Windows 로컬 경로의 대소문자/정규화 경로를 통일합니다. 동일 Repo 재등록 시 기존 id·name·targets·analysis를 그대로 반환하며 다시 분석하지 않습니다. 재시작 이후에도 유지되고 중복 동시 등록은 SQLite UNIQUE 제약으로 방지합니다.

## 구현 기능과 분석 한계

- Spring Boot Gradle/Kotlin Gradle/Maven, Next.js/Express/React/Vue, FastAPI/Django/Flask의 manifest 정적 분석을 재사용했습니다.
- 팀 Analysis 필드 13개(`stack`, `port`, `java_version`, `database`, `database_name`, `health_path`, `uses_server_session`, `summary`, `routes`, `evidence`, `env`, `secret_env`, `warnings`)와 Project 필드 전체를 제공합니다.
- 근거는 상대 파일 경로와 `source=rule/default`로 기록합니다. 포트·health_path 기본값과 미확인 세션 여부는 warnings로 표시합니다. Actuator 경로도 검증되지 않은 기본 후보입니다.
- Spring Controller의 단순 매핑, 명시/암시 RequestParam 이름, JSON body 존재, 서버 세션 코드 참조를 추출합니다. 동적/배열 매핑은 추측하지 않고 생략하며 경고합니다. Java AST 전체 해석이나 실행 시 등록되는 라우트는 지원하지 않습니다.
- 프로파일별 설정은 적용하지 않습니다. 다중 문서/포트/환경변수 충돌은 경고하고 확정할 수 없는 값을 생략하거나 명시된 기본값으로 대체합니다. 여러 앱이 있는 Repo는 루트 앱만 분석하거나 모호하면 400을 반환합니다.
- 파일당 1MB, 설정 및 Java 각각 250파일, 디렉터리 각각 5,000개 제한을 적용합니다. symlink/junction을 따라 외부 파일을 탐색하지 않습니다.
- 비밀번호/API key/token 값과 `.env.example` 값은 Project나 로그에 출력하지 않습니다. `env`는 허용된 비민감 Spring 설정만 제공합니다. JDBC URL의 인증정보·query는 전달하지 않습니다. `secret_env`와 `secrets`는 이름만 사용하고 secrets.value는 항상 `••••••••`입니다. 미분류 환경변수 참조도 보수적으로 이름만 보관합니다.
- `analysis_cost`는 AI 호출이 없으므로 모두 0입니다. Summary는 정적 규칙 요약입니다.
- `ports={}`는 실제 호스트 포트를 아직 할당하지 않았다는 뜻이며 `analysis.port`는 앱 포트 후보입니다. `last_deployment=null`을 유지합니다.

## 기존 코드 재사용

읽기 전용 원본 `D:/workspaces/orca-workspace/deploy-orchestrator-mvp/app/analyzer.py`를 `engine/legacy_analyzer.py`로 이관했습니다.
기존 manifest/Dockerfile/Compose/Spring 설정 분석, 충돌 처리, clone 오류 비노출, 스캔 제한을 재사용하고 근거 수집 hook, Windows junction 제외, clone 저장 위치를 보강했습니다. DeployConfig/DatabaseConfig는 내부 호환 타입으로만 유지하고 API에는 팀 Analysis/Project로 변환합니다. requirements.txt의 의존성 구성도 재사용했습니다.

개인 STEP 2~3의 Orchestrator/HTTP Adapter는 동기 호출 및 SUCCESS/Health PASS/개인 ShakedownResult 계약을 사용합니다. 팀의 비동기 POST→GET 폴링 및 StepDiff/Verdict/Report 계약과 바로 호환되지 않아 그대로 이관하지 않았습니다. 기존 229개 테스트가 이 Worktree에 모두 이관되거나 통과했다는 의미는 아닙니다.

## 검증 및 Mock 기능

`apps/engine`에서:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m compileall -q engine tests
```

Worktree 루트에서는:

```powershell
python -m pytest -c apps/engine/pytest.ini apps/engine/tests -q
python -m compileall -q apps/engine/engine apps/engine/tests
```

**60개 테스트 통과**, Python 문법 검사 통과. Windows 실제 `localhost:8700` HTTP로 health, Project 등록·상세·목록, CORS를 확인했습니다. 테스트에서는 Git clone 성공/실패/timeout을 Mock으로 대체합니다. 실제 GitHub 네트워크 clone은 이번 검증에 포함하지 않았습니다.
현재 설치된 Starlette의 TestClient/httpx 조합에서 deprecation warning 1개가 발생하지만 테스트 실패는 없습니다.

Mock 배포 API/Mock Shakedown 실행은 **미구현**입니다. 빈 배포 목록과 501 응답을 Mock 성공으로 표시하지 않습니다. 배포 상세/이벤트 SSE API도 아직 구현하지 않았습니다. 따라서 Mock 실패 시 Shakedown 미호출 테스트는 배포 Mock 구현 시 추가해야 합니다.

## 10/9 실제 연동 및 팀 확인 사항

1. Local/AWS 담당자가 구현하는 Target API의 POST 202 → GET 폴링 연결. `ready`는 공개 URL의 health check를 인프라가 통과했다는 의미를 그대로 사용하고 Engine은 기능 검사나 중복 health check를 구현하지 않습니다.
2. 모든 대상 ready 후 Shakedown 담당자의 POST 202 → GET 폴링 연결. StepDiff/Verdict/Report를 전달하고 Engine에서 Playwright·단계 비교·AI 원인 보고서를 생성하지 않습니다.
3. 공통 이미지 빌드·레지스트리 업로드 책임과 image 공급 방식 확정. 실제 빌드, 자동 수정·재배포, 승격은 현재 지원하지 않습니다.
4. secret_env 이름 → 인프라 secret_refs 이름 매핑 확정. 현재 응답의 마스킹 값은 실제 secret이 등록되었음을 의미하지 않습니다. 비민감 환경변수 참조의 별도 입력 흐름도 협의해야 합니다.
5. Analysis의 DB 이름과 Target API database.engine enum 간 Adapter 매핑 확인. 기존 분석기의 `postgresql`은 Target의 `postgres`와 이름이 다르고, mariadb/mongodb/sqlite는 Target enum에 없습니다. 공통 Contracts를 임의로 변경하지 않았습니다.
6. 호스트 포트 할당/Project.ports 책임, 활성 Spring 프로파일 선택, Shakedown WARN 처리, timeout/409/SSE 정책을 연동 때 확인합니다.
7. engine.yaml은 targets 생략 기본값을 허용하고 TypeScript CreateProjectRequest는 필수로 선언합니다. 현재 Python은 OpenAPI 기본값을 적용하고 Dashboard 입력은 그대로 받습니다. fixture analysis_cost.items는 TS CostLedger에 없어 응답에 포함하지 않습니다. 향후 계약 통일이 필요하면 공통 담당자와 협의합니다.

Docker/AWS/Cloudflare 실제 배포, 공통 이미지 빌드, AI 호출, commit/push/merge는 수행하지 않았습니다. 모든 파일 변경은 `apps/engine` 안에만 있습니다.
