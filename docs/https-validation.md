# HTTPS 모듈 구현·검증 기록

작성: 김재환 / 2026-10-09

최신 AWS 배포 통합 검증과 수정 결과는 [AWS HTTPS 통합 검증](https-aws-validation.md)에 정리했다. 아래 164개 검사는 최초 구현 시점의 기록이다.

## 최초 구현 기준

- 브랜치: `feat/https-automation`
- 기준 main: `6c00448609fe087eb1bece8a3588f637695a3102` (PR #10 통합). 마무리 시 원격 main도 같은 커밋임을 확인했다.
- 다른 담당자의 미병합 PR을 합치지 않았다. 이 브랜치는 2026-10-09 PR #21로 제출했다.
- 설계와 실행 안내: [HTTPS README](../infra/https/README.md), [공통 API](../packages/contracts/https.openapi.yaml).

## 구현한 범위

기존 리소스에 사용자 서브도메인을 연결하는 Fastify/SQLite 내부 서비스(9301), 설정 시작·상태 조회·재확인 API, 한국어 설정 화면, 엔진의 검증된 HTTPS 주소 전달을 구현했다. DNS는 사용자가 직접 등록한다.

어댑터는 AWS ALB/ACM, Azure Container Apps, Azure App Service, GCP 기존 글로벌 외부 ALB/Certificate Manager, Cloudflare 원격 관리 Named Tunnel, 전용 Caddy를 지원한다. 아래 클라우드 항목은 코드와 대역 테스트가 준비된 상태이며 실제 계정에서 성공한 결과는 아니다.

동일 요청 재사용, 동시 변경 잠금, 프로세스 재시작 후 재개, 24시간 대기 제한, 변경 의도 저장, 소유한 설정만 복원, 외부 변경 충돌 중단을 구현했다. 인증서 발급/접속 확인이 끝난 뒤 리다이렉트한다. 갱신 검사 실패는 HTTPS 설정을 보존하고 확인 필요로 표시한다.

AWS Target은 선택 설정 `httpsControlUrl`로 80/443 차단을 함께 요청한다. 게이트 열기는 연결 상태가 ready일 때만 허용하며, 재검증 실패(needs_action) 상태에서는 ALB를 바꾸지 않고 409를 반환한다. 리스너 방식과 `gateRuleArn` 방식을 모두 처리한다. 부분 설정 중 중지는 생성한 HTTPS 경로를 복원한다. 제어 서비스 장애나 차단 확인 실패를 정상 정리 완료로 보고하지 않는다.

## 최초 구현에서 실행한 검사

| 검사 | 결과 | 의미와 한계 |
| --- | --- | --- |
| `npm run test:https` | 29/29 통과 | 상태/API/SQLite/도메인/DNS/인증서·리다이렉트/오류·복원·게이트. 공급자 API는 대역이며 TLS 시험 한 건은 실제 로컬 소켓 사용 |
| `npm run test:aws` | 17/17 통과 | 기존 AWS 회귀 + HTTPS 배포·중지 연결 + 서비스 장애. AWS SDK/HTTP 대역 |
| 엔진 `pytest apps/engine/tests -q` | 118/118 통과 | 기존 배포·시운전 회귀 + HTTPS API/주소 검증. 기존 Starlette/httpx 관련 경고 1건 |
| `npm run check:https`, `npm run check:aws` | 통과 | TypeScript 타입 검사 |
| `npm run lint:web`, `npm run build:web` | 통과 | 웹 lint·타입·프로덕션 빌드 |
| 설정 예시 2개 | 스키마 검사 통과 | 빈 설정과 6개 공급자 예시. 예시는 실제 계정이 아님 |
| HTTPS OpenAPI | YAML 파싱·내부 참조 검사 통과 | 실 공급자 API의 호환성 인증을 뜻하지 않음 |
| `git diff --check` | 통과 | 패치 공백 검사 |

총 164개 자동 테스트가 통과했다. 자동 테스트 숫자에는 아래 별도 Caddy 실증은 포함하지 않았다.

## 실제 로컬 TLS·Caddy 확인

Node TLS 서버와 임시 CA로 정상 체인/SAN 연결 성공, 신뢰되지 않은 CA·다른 도메인 실패를 확인했다. 공개 DNS 검사에서 사설 주소를 거절했다. 신뢰 예외는 시험 요청의 임시 CA에만 적용하며 검증을 끄거나 운영체제 신뢰 저장소를 변경하지 않았다.

공식 Caddy 2.10.2 macOS arm64 바이너리의 배포 체크섬을 확인한 뒤 임시 디렉터리·loopback 포트에서 실행했다.

```json
{
  "caddy": "2.10.2",
  "production_config": "valid",
  "local_trusted_https": "pass",
  "redirect_path_query": "pass",
  "rollback": "pass",
  "public_acme": "not_tested"
}
```

실제 Caddy parser로 생성한 ACME 설정을 검증했고, 실행 검증은 내부 CA를 사용했다. HTTPS 응답과 HTTP→HTTPS 경로·쿼리 보존, 원래 설정 복원을 확인했다. 설정 reload 직후의 연결 교체를 고려해 새 TLS 연결과 전파 대기를 적용했다. 임시 프로세스·인증서·시험 데이터는 정리했다. 재현 스크립트는 `infra/https/test/caddy-smoke.ts`다.

## 한국어 화면 확인

실제 Next.js 화면 → 엔진 → 빈 설정의 HTTPS 서비스까지 연결해 도메인 입력과 시작 요청을 확인했다. 기반 리소스가 없으면 준비 필요 안내가 표시됐으며 성공으로 표시되지 않았다. 주기적 상태 조회가 오류 안내를 지우는 문제를 수정하고 다시 확인했다.

이 화면 검수는 DNS 발급 성공 화면의 실제 클라우드 검수가 아니다. 기존 프로젝트 분석 화면의 중복 React key 경고는 HTTPS 모듈 밖의 별도 항목으로 남아 있다.

## 아직 검증하지 않은 환경

AWS 검증 도메인으로 `softbank.jaehwan.kr`을 전달받아 실제 접속을 확인했으나 HTTP 404와 TLS handshake 실패 상태였다. 전용 CLI 인증과 대상 ALB 연결 정보가 확인되지 않아 아래 실제 클라우드 검증은 남아 있다. 개인 AWS 프로필은 사용하지 않았고 실제 클라우드/DNS 변경도 수행하지 않았다.

- AWS ACM 공개 발급, IAM 실권한, ALB 80/443 실제 차단·재배포·중지, DNS 전파.
- Azure Container Apps 및 App Service의 실제 관리형 인증서 발급·바인딩·복원과 요금제/CAA 조건.
- GCP API 활성화·권한, 기존 Cloud Run/serverless NEG/LB 연결, Certificate Manager 실제 발급 및 비동기 리소스 반영.
- Cloudflare 플랜·토큰별 certificate pack/redirect API 접근, 실제 Named Tunnel 라우팅과 edge 인증서.
- Caddy 공개 ACME 발급·장기간 자동 갱신, 공인 IP/NAT/외부 80·443 접근.
- 실제 클라우드 HTTPS 주소로 팀 엔진에서 시운전까지 수행한 전체 흐름.

## 팀과 맞출 연결 정보

1. AWS PR #12의 `GateRuleArn`과 HTTPS 서비스 설정, AWS Target의 `httpsControlUrl`을 함께 적용한다. PR #12의 `496582b`와 HTTPS 코드를 별도 로컬 브랜치에서 합성해 코드 통합 검증을 마쳤고, 규칙 방식의 대상 그룹 연결 유지 문제를 수정했다. 원격 병합과 실제 ALB 80/443 차단 확인은 별도다.
2. Azure/GCP 대상 서비스의 9103 중복을 정리한다. 현재 main의 엔진 자동 배포는 Local/AWS 기준이다. Azure/GCP HTTPS 어댑터는 등록된 기존 리소스에 직접 연결하며, 미병합 대상 배포 엔진과의 자동 흐름은 별도 통합이 필요하다.
3. 프로젝트별 전용 계정 참조, 공개 진입점, 원본 배포 URL, 쿠키 없이 200을 반환하는 헬스 경로, 수동 DNS 담당을 정한다. GCP의 LB가 없으면 HTTPS 모듈이 새 LB를 대신 만들지 않는다.
4. 첫 앱 배포 완료 후 HTTPS를 설정한다. DNS 대기와 앱 재배포를 동시에 진행하지 않는다. HTTPS 적용 후에는 엔진·AWS Target·HTTPS 서비스를 함께 실행한다.

HSTS, 앱 코드/쿠키 자동 수정, 내부 서비스 TLS/mTLS, 운영용 다중 사용자 인증/인가, 도메인 교체·삭제 UI는 이번 범위에 포함하지 않았다. 공개 진입점 TLS와 앱 시운전 PASS는 서로 다른 결과다.
