# Engine — 분석 + 로컬 배포 연결

Action 버튼에서 프로젝트 분석 → Docker 이미지 빌드 → Local Target POST → 준비 상태 폴링 → 공개 URL 표시까지 실행합니다. **AWS 호출, 시운전, AI 보고서, 자동수정은 아직 연결하지 않습니다.** `deployed`는 배포만 완료된 상태이며 `promoted`나 검사 PASS가 아닙니다.

## 실행

Python 3.12+, Node, Git, 실행 중인 Docker가 필요합니다. 저장소 루트에서 실행합니다.

```sh
python3 -m venv apps/engine/.venv
apps/engine/.venv/bin/pip install -r apps/engine/requirements.txt
npm ci --ignore-scripts
```

각각 별도 터미널에서:

```sh
# 먼저 infra/local/README.md에 따라 .env의 LOCAL_DB_PASSWORD를 설정
node --env-file=infra/local/.env infra/local/server.mjs

# 단일 프로세스/worker로 실행. 공유 SQLite에 여러 엔진을 띄우지 않음
apps/engine/.venv/bin/uvicorn engine.api:app --app-dir apps/engine --host 127.0.0.1 --port 8700

npm run dev:web:live
```

Windows에서는 `.venv/Scripts/python.exe -m uvicorn`을 사용합니다.
[대시보드](http://localhost:3700)에 `samples/kty-board`를 입력하고 Action을 누릅니다. 실제 모드에서는 Local만 선택 가능하고 시운전·자동수정은 비활성화됩니다. `dev:web:live`는 같은 origin의 `/engine` 프록시로 8700 엔진에 연결합니다. 엔진 URL 없이 `npm run dev:web`로 실행하면 기존 fixture 데모 모드입니다.

## 현재 지원 범위

- 로컬 샘플 디렉터리 또는 공개 GitHub HTTPS 저장소. Dockerfile이 분석된 앱 디렉터리에 있어야 합니다. 여러 앱이 있는 이 모노레포는 `samples/kty-board` 경로를 사용하세요.
- 실제 빌드할 checkout을 다시 분석합니다. 등록 시점 이후 소스 변경도 반영됩니다. Dockerfile의 코드를 실행하므로 신뢰하는 저장소를 사용하세요.
- 현재 배포 어댑터는 PostgreSQL 샘플용입니다. DB 이름이 미확정이면 `board_db`, 비밀번호는 Local Target의 `db_password` secret reference를 사용합니다. 분석 결과의 프로파일별 env는 자동 전달하지 않습니다.
- 배포마다 고유 이미지 태그와 Docker 스택/볼륨을 만듭니다. 기존 성공 배포는 자동 삭제하지 않습니다. 새 배포가 이전 배포의 DB를 이어 쓰는 업데이트 기능은 아직 없습니다.
- 기본 Local 옵션: replicas=1, sticky_sessions=false, tz=Asia/Seoul. 다른 대상·미지원 옵션은 거절합니다.
- 빌드 제한 900초, Target 준비 폴링 300초, 개별 HTTP 요청 20초. 빌드 stdout/stderr는 비밀 유출을 막기 위해 API로 내보내지 않습니다. SSE에는 단계 변경을 전달합니다.
- 배포 실패/시간 초과 시 해당 Target ID만 DELETE합니다. Local Target은 삭제 전 로그와 DB 볼륨을 보존합니다. 정리 실패는 engine error에 표시합니다.
- 엔진이 중간에 종료되면 재시작 시 해당 기록은 failed로 표시합니다. 자동으로 성공 처리하거나 재배포하지 않습니다. 기존 Target 리소스를 확인하고 정리한 뒤 재시도하세요.

## API

| API | 동작 |
|---|---|
| `GET /api/health` | 엔진 상태 |
| `POST /api/projects` | repo, 선택적 name/targets로 분석·등록 |
| `GET /api/projects` | 프로젝트 목록 |
| `GET /api/projects/{id}` | 프로젝트 상세와 최신 배포 |
| `POST /api/projects/{id}/deployments` | 202 비동기 접수. 실행 중 같은 프로젝트는 409 |
| `GET /api/deployments?project_id=...` | 저장된 배포 목록 |
| `GET /api/deployments/{id}` | 상태·시간·이미지·Target URL |
| `GET /api/deployments/{id}/events` | SSE stage/log/done. 재연결 시 현재 상태부터 전달 |

배포 요청:

```json
{"targets":["local"],"shakedown":false,"autofix":false,"options":{}}
```

시운전/자동수정 true는 400으로 거절합니다. 성공 응답의 `attempts`는 빈 배열, `ai_cost`는 0입니다. 상태는 queued → building → deploying → deployed 또는 failed입니다.

프로젝트·배포 기록은 `apps/engine/.data/*.sqlite3`에 저장합니다. 상대 경로는 저장소 루트 기준입니다. 같은 repo 등록은 기존 프로젝트를 반환합니다. 프로젝트 targets는 한 개 이상 허용하며, 생략 시 기존 계약의 `[local, aws]`를 유지합니다. 배포 요청 targets의 기본값은 `[local]`이며 AWS로 자동 확장하지 않습니다.

엔진은 loopback에 바인딩하고 dashboard의 localhost/127.0.0.1:3700 Origin만 허용합니다. Local Target 주소는 127.0.0.1:9101로 고정합니다.

## 분석 한계

기존 정적 분석기(`legacy_analyzer.py`)의 Spring Boot/Node/Python manifest 분석과 팀 Analysis 변환을 유지합니다. Java route는 단순 annotation 기반이며, 프로파일별 설정·동적 mapping·실행 시 설정은 확정하지 않습니다. env-backed DB 이름과 포트 등은 경고/기본값이 있을 수 있습니다. 비밀값은 Project로 반환하지 않습니다. 분석 결과는 배포 성공이나 기능 검사를 보장하지 않습니다.

## 검증

```sh
apps/engine/.venv/bin/python -m pytest apps/engine/tests -q
npm run build:web
npm run lint:web
```

2026-10-08: 엔진 테스트 67개 통과. 실제 대시보드 Action → Docker 빌드 → PostgreSQL/Cloudflare 배포 → URL 표시 확인(약 13초). 시운전·AWS는 실행하지 않았습니다. 테스트의 Target 대역은 비동기 상태, 동시 배포 거절, 실패/timeout 정리, 재시작 복구, SSE 완료와 비밀값 비노출을 검증합니다.

다음 연결 지점은 AWS 이미지 업로드/digest 공유와 Target 호출, 이후 김태현 담당 Shakedown API 호출·판정 전달입니다. 현재 엔진은 Playwright나 판정 로직을 구현하지 않습니다.
