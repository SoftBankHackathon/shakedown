# packages/contracts

팀 공통 API 명세와 데이터 형식

영역끼리는 아래 OpenAPI 명세대로 통신합니다. 10/9 연결 전에 각자 이 명세대로 만들어 두면 그대로 붙습니다.

```
대시보드(web) ──engine.yaml──▶ 엔진(engine) ──target.yaml──▶ 인프라(local, aws, gcp)
                                     └──────shakedown.yaml──▶ 시운전(shakedown)
```

| 명세 | 구현 | 호출 | 핵심 |
|---|---|---|---|
| `openapi/target.yaml` | infra/local, infra/aws, infra/gcp | engine | 배포 요청 → 상태 폴링 → `ready`면 공개 `url` |
| `openapi/shakedown.yaml` | apps/shakedown | engine | 대상 URL들 → 단계별 비교, 판정, 원인 보고서 |
| `openapi/engine.yaml` | apps/engine | apps/web | 프로젝트, Deploy, 배포 상태, 실시간 이벤트(SSE) |

- TypeScript 타입: `src/index.ts`
- 실제 예시 데이터: `fixtures/`
- 필드 이름은 snake_case로 통일
- 형식을 바꿀 때는 팀 채널에 먼저 공유하고, 명세와 fixture를 같이 고칩니다.
- 명세 검사: `npx @redocly/cli@1.34.5 lint packages/contracts/openapi/*.yaml`

## 상태: 초안

Target API는 **v0.1.2 통합 제안**, Engine API는 **v0.1.5 통합 제안**, Shakedown API는 **v0.1.1 초안**입니다. 팀 리뷰 전이라 바뀔 수 있습니다.

바뀔 가능성이 있는 것
- 상태 확인 방식: 지금은 GET 폴링(2~3초 간격). 콜백(`callback_url`) 방식이 추가될 수 있음
- 보고서 언어: 시운전 요청에 `lang`(ko, en, ja) 추가 검토 중
- 같은 프로젝트 동시 배포: 지금은 409로 거절. 필요하면 대기열 방식으로 바뀔 수 있음
- 대상 이름: 지금은 `local`, `aws`, `gcp` 구현. `onprem`, `azure`는 예정
- 비교 대상이 3개 이상일 때의 결과 형식: `StepDiff`에 `baseline`, `candidate`를 넣어 두었고 세부는 미정

바꿀 때
1. 팀 채널에 먼저 공유
2. 명세(`openapi/*.yaml`), 타입(`src/index.ts`), 예시(`fixtures/`)를 함께 수정
3. 각 명세의 `info.version`을 올리고 아래 변경 이력에 한 줄 추가

## 변경 이력

- **Engine v0.1.5 (2026-10-10, 제안. 팀 채널 공유·담당자 확인 TBD)**: `POST /api/deployments/{id}/fix`(operationId applyFix, 본문 없음) 추가. blocked 배포의 자동 적용 가능 env 수정안을 한 번 적용해 클라우드만 같은 digest·같은 본문에 env를 더해 새 배포 ID로 다시 배포하고 2회차 시운전(blocked → fixing → 결과). 지금은 엔진이 배포한 Local+GCP만, AWS는 실계정 검증 전이라 400. 최신 배포가 아니거나 blocked가 아니면 409. `TargetState`에 `deployment_id`(Target API에 실제로 쓴 ID)와 `request`(받아들여진 Target API 본문) 추가, 1회차의 `applied_fix` 기록, `ai_cost`는 회차 합. fixture에 `targets.*.deployment_id`·`request` 예시 추가. blocked는 더 이상 완전한 종료 상태가 아님(`TERMINAL_STATUSES` 주석).
- **Shakedown v0.1.1 (2026-10-09, 제안. 팀 채널 공유·담당자 확인 TBD)**: `Report.fix.option`에 `env` 추가(value는 `KEY=VALUE` 한 개, 같은 이미지에 env만 더해 재배포). 로그인 풀림 규칙 수정안을 스티키 세션에서 `SPRING_PROFILES_ACTIVE=demo,session-jdbc`(세션을 공유 DB에)로 바꿈. 요청 `hints`에 알려진 키 `can_apply_env` 추가: true일 때만 그 수정안이 `auto_applicable: true`이고, AI 보고서도 그 fix를 바꾸지 않음. 요청·응답 형식은 그대로.
- **fixture `deployment-blocked-then-fixed.json` (2026-10-09)**: 1회차 수정안·applied_fix를 위 env 수정안으로 교체하고, 비교 대상을 엔진이 실제로 env 수정을 적용하는 gcp로 바꿈(키 `aws`→`gcp`, 라벨 `GCP Cloud Run`, `project.json`의 ports·targets도 같이). 2회차가 스티키를 켜지 않도록 `sticky_sessions`를 모두 false로, `targets.gcp.info.session`을 `jdbc`로, `autofix`를 false(사용자가 수정 적용을 누르는 흐름)로 맞추고, 엔진이 남기는 `deployment_id`·`request`를 넣음. 단계·판정·원인 문장은 그대로(시뮬레이션 기록이라 URL은 localhost).
- **Target v0.1.2 (2026-10-09, 팀 채널 공유 후 제안)**: GCP 구현(infra/gcp, Cloud Run + Cloud SQL PostgreSQL) 추가. servers에 9103, 설명에 GCP 구현 제약 절(수동 스케일링 replicas 1~2, sticky best-effort, digest 필수, DELETE 뒤 공개 주소는 403 대신 503, 매 배포 schema-init). 요청·응답 형식은 그대로라 타입은 TargetName 주석만 고쳤고 fixture는 추가하지 않음. `infra/gcp/README.md` 참고.
- **Engine v0.1.4 (2026-10-10, 팀 채널 공유 후 제안)**: 배포 요청 targets에 gcp 추가. gcp는 다른 클라우드(aws·azure)와 함께 보내면 400. 엔진에 이미 들어간 Azure(#23)에 맞춰 enum에 azure, maxItems를 3으로. 요청·응답 형식은 그대로. `apps/engine/README.md`의 GCP 연결 설정 참고.
- **Engine v0.1.1 (2026-10-08, PR #5 리뷰 대기)**: 로컬 배포 후 선택적 HTTP 시운전, 기존 URL 비교 API, external 대상 상태, warned 종료 상태, release_gate/traffic_blocked 의미 추가. `fixtures/deployment-comparison-pass.json` 참고. AWS 자동배포·자동수정·실제 트래픽 차단은 미연결.

- **Target v0.1.1 (2026-10-08, 팀 통합 전 제안)**: AWS 구현을 ECS Fargate/ALB로 반영. digest 고정, 지원 옵션, 409, DELETE의 실제 공개 차단/DB 보존 및 삭제 ID 처리를 명시. `infra/aws/README.md`의 연동 절차와 `fixtures/aws-target-ready.json` 참고. Slack 합의 완료를 뜻하지 않음.

- **v0.1.0 (2026-10-08)**: 첫 초안. 엔진·인프라·시운전 API, 대상 선택(`targets`), 같은 프로젝트 동시 배포 409, 시운전 결과에 대상 이름(`baseline`, `candidate`)


### 2026-10-09 — 엔진 v0.1.2 이미지 계획·API 설정
Claude 연결 상태/연결 테스트/해제 및 이미지 계획/비동기 빌드/조회 경로를 추가했습니다. 키는 write-only이며 메모리에만 저장합니다. 이미지 built는 런타임 검증이나 배포 완료를 뜻하지 않습니다. 공유 타입에 LlmConnectionStatus, ImagePlan, ImageBuild를 추가했습니다.

이미지 계획은 기존 Dockerfile → 규칙 → Claude 1회 fallback 순서입니다. use_ai 기본값은 true이며 false는 fallback을 금지합니다. source는 existing/rule/ai-fallback입니다. image_only 등록은 알 수 없는 단일 앱도 이미지 생성 단계로 진행하며 일반 배포 지원 범위를 확대하지 않습니다.

### v0.1.3 제안 — AWS 아키텍처 판단

ArchitectureRequest/Plan/Tier와 계획 생성·최근 조회·선택 저장 API를 추가합니다. `aws-architecture.v1`은 규칙/AI 출처와 근거, 누락 입력, 차단 항목, 세 프리셋을 반환합니다. 계획은 DB에 저장되지만 인프라 적용은 하지 않으며 `deployment.ready=false`입니다. PR #11의 Claude 연결에 의존하는 후속 변경입니다.
