# 2026-10-08 통합 점검 — 김태윤 / Emerald

검토 기준 main: `8f00427` (PR #6 HTTP CLI, #7 HTTP API, #8 규칙 보고서, #9 Claude 보고서까지 머지). 기존 PR #5의 로컬 배포 연결은 main에 없으므로 여전히 유효합니다. #5 브랜치에 최신 main을 반영하고 아래 통합 수정을 추가했습니다. **PR 리뷰 대기이며 main 병합은 하지 않았습니다.**

## 반영한 수정

1. Engine → Shakedown POST/GET 폴링, 시나리오·단계별 결과·판정·보고서·AI 비용을 SQLite와 대시보드에 전달.
2. 새 로컬 배포 + 기존 candidate 비교, 기존 URL 두 개만 비교하는 별도 API/UI.
3. WARN 종료 상태, 단계 진행 SSE, 비교 모드에서 불필요한 빌드 표시 제거. 외부 대상은 external로 표시하고 배포/삭제하지 않음.
4. baseline 실패·누락 결과·모순된 PASS·runner 장애/timeout은 failed. 거짓 PASS를 만들지 않음.
5. 시운전 마감 후 HTTP 요청·접속 재시도 취소. 이미 대상 서버에 접수된 쓰기는 취소/롤백을 보장하지 않음.
6. 실제 `X-Instance-Id` 헤더를 hop에 기록하여 어느 인스턴스에서 로그인 세션이 끊겼는지 확인 가능.
7. Quick Tunnel 주소의 로컬 DNS NXDOMAIN 캐시 때문에 Local Target은 ready인데 시운전만 접속 실패하던 통합 오류 수정. trycloudflare HTTPS에만 DNS fallback을 적용하고 원래 SNI/TLS 인증서는 검증. POST 재실행이나 OS DNS 변경은 없음.
8. `blocked`는 검사 게이트이고 실제 외부 URL 접속 차단이 아님을 UI/API/문서에 명시. 자동수정은 여전히 거절.

## 검증 결과

- Engine 82 tests; Shakedown 100 tests; AWS adapter 15 tests; Local Target 7 tests.
- Next production build, ESLint, Web/AWS/Shakedown strict TypeScript 검사, Java 테스트 3개 통과. OpenAPI lint는 오류 0개, 문서 경고 15개.
- 실제 PostgreSQL 17 + Spring Boot 앱 두 인스턴스 + round-robin 프록시:
  - 메모리 세션: Engine → Shakedown 8단계 **BLOCKED**, 규칙 원인 보고서와 두 instance hop 확인.
  - JDBC 공유 세션: 같은 경로 **8단계 PASS**.
  - 교차 인스턴스 로그인/글쓰기, 앱 재시작 후 로그인·게시글 유지 확인.
  - 세션 스키마 초기화 두 번 실행의 멱등성 확인.
- 실제 새 로컬 배포 → Cloudflare → Shakedown 전체 경로도 약 20.6초에 8단계 PASS 확인. 초기 DNS 실패를 재현한 뒤 수정본으로 재실행했습니다.
- 이 검증에서는 실제 AWS 호출과 유료 Claude API 호출을 하지 않았습니다. AI 성공/실패 fallback은 팀의 mock provider 테스트로 검증했습니다.
- 테스트 컨테이너는 스크립트에서 만든 것만 정리합니다. 기존 사용자 컨테이너는 유지합니다.

통합 테스트 실행 예시(별도 loopback 엔진/시운전 서비스를 먼저 실행, 기준 게시판도 별도 준비):

```sh
docker build -t shakedown-board:integration-audit samples/kty-board
ENGINE_SMOKE_URL=http://127.0.0.1:8700 \
ENGINE_SMOKE_PROJECT=prj_REPLACE_WITH_REGISTERED_PROJECT \
ENGINE_SMOKE_BASELINE=http://127.0.0.1:18080 \
SHAKEDOWN_TEST_IMAGE=shakedown-board:integration-audit \
SHAKEDOWN_TEST_PLATFORM=linux/arm64 \
python3 infra/aws/scripts/session-smoke.py
```

Intel 머신에서는 platform을 linux/amd64로 변경합니다. 결과는 `.data/session-smoke/latest.json`에 저장됩니다. 프로젝트 등록은 엔진 `POST /api/projects`를 사용합니다. baseline은 candidate와 다른 DB/환경이어야 합니다.

## 제품 완성까지 남은 작업

| 항목 | 현재 상태 / 다음 작업 |
|---|---|
| AWS 원클릭 배포 | 어댑터 구현 존재. 엔진의 ECR 이미지 업로드·digest 공유·AWS Target 호출과 실제 계정 검증 필요 |
| 자동수정·트래픽 제어 | 보고서 fix는 제안. 옵션 적용/재배포/재시운전 및 차단·승격 정책 미연결 |
| 시운전 범위 | HTTP 8단계, Playwright 아님. JS 렌더링·브라우저 사용자 경험 검증은 별도 |
| 보고서 정확도 | 규칙 원인은 패턴 추정. 인스턴스 헤더/세션·DB 설정과 함께 확인 필요 |
| 운영 보안 | 샘플 앱 수정/삭제 권한 검사, 비밀번호 해시, CSRF/요청 제한, 리소스 제한 보강 필요. 공개 운영용으로 안전하다고 볼 수 없음 |
| 배포 수명주기 | 새 배포마다 독립 DB. 기존 데이터 승계·성공 스택 정리·영구 도메인 정책 필요 |

기존 작업 디렉터리에 `* 2.*` 이름의 미추적 복제 파일들이 있어 Java 중복 컴파일 가능성이 있습니다. 사용자 파일을 임의 삭제하지 않고 깨끗한 worktree에서 검증했으며 해당 복제 파일들은 PR에 넣지 않았습니다.
