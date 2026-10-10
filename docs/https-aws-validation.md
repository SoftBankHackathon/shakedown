# AWS 배포와 HTTPS 모듈 통합 검증

작성: 김재환 / 2026-10-09

AWS 배포 모듈과 HTTPS 모듈을 연결해 최초 배포, 인증서 설정, 재배포, 중지, 재시작을 검증했다. HTTPS 설정이 ALB 대상 그룹 연결을 제거하는 문제를 재현하고 수정했다. 통합 자동 검사 320개와 웹 빌드가 통과했다. AWS 제어 API는 대역을 사용했으며, 실제 AWS 인증서 발급과 ALB 접속 성공을 확인한 결과는 아니다.

## 검증한 코드

- AWS PR #12: `496582b4a42aa205fcd9f159247d451c0b732fb9`.
- HTTPS 원본: `fc54042`. 기존 기능 브랜치의 기준 main은 `6c004486`이다.
- 조회한 원격 main: `28d66ed`. PR #12는 main에 포함되지 않은 상태였다.
- 별도 로컬 브랜치 `test/https-aws-integration`에서 AWS PR #12 위에 HTTPS 코드를 합성했다. 엔진 초기화, 웹 설정 화면, AWS 구성/공급자, 계약 타입의 충돌을 해결했다. 원격 PR이나 main을 병합하지 않았다.
- HTTPS 수정은 원래 `feat/https-automation`에도 반영했다. AWS PR #12의 다른 기능을 해당 브랜치에 가져오지는 않았다.

## 발견한 문제와 수정

PR #12의 ALB는 HTTP 기본 동작의 대상 그룹 연결을 유지하고 우선순위 1의 전체 IPv4/IPv6 규칙으로 공개 트래픽을 제어한다. HTTPS 모듈은 이 규칙뿐 아니라 기본 동작까지 리다이렉트나 403으로 변경하고 있었다. HTTPS 리스너도 재배포 준비 중 403이 되면 대상 그룹에 연결된 forward 동작이 모두 없어질 수 있었다.

두 모듈이 같은 ELB 상태를 사용하는 테스트에서 수정 전 `HTTPS must retain the ALB target-group association required by ECS` 실패를 재현했다. 규칙 방식에서는 HTTP 기본 forward를 보존하고, 리다이렉트와 차단은 게이트 규칙에서 처리하도록 수정했다. 게이트가 우선순위 1이며 `0.0.0.0/0`과 `::/0`을 모두 포함하는지 인증서 요청 전에 확인한다. 기존 리스너 방식의 처리는 유지했다.

추가로 HTTPS 제어 응답에서 `configured`와 `blocked`의 불명확한 값을 거절하고, 차단 상태가 true이거나 확인되지 않은 HTTPS 주소를 엔진이 시운전에 전달하지 않도록 했다.

## 검증 결과

| 검사 | 결과 | 실행 범위 |
| --- | --- | --- |
| HTTPS | 32/32 통과 | 공급자·상태·복원 회귀, 실제 로컬 TLS, AWS 통합 3개 |
| AWS | 30/30 통과 | PR #12 회귀, HTTPS 배포·중지 연결, 제어 응답 검증 |
| 엔진 | 258/258 통과 | PR #12 회귀, 등록된 HTTPS 주소 전달, PASS/BLOCKED 흐름 |
| HTTPS/AWS 타입 검사 | 통과 | TypeScript |
| 웹 lint 및 프로덕션 빌드 | 통과 | 통합된 Next.js 화면과 타입 |
| 기존 HTTPS 브랜치 재검사 | 171/171 통과 | HTTPS 29 + AWS 18 + 엔진 124, 타입 검사 통과 |

통합 검사 320개와 기존 브랜치 재검사 171개는 중복 범위가 있으므로 합산하지 않는다. 엔진에는 기존 Starlette/httpx deprecation 경고 1건이 있다.

### AWS 통합 테스트의 경계

`infra/https/test/aws-integration.test.ts`는 실제 AWS Target 코드, HTTPS Manager/공급자/SQLite와 실제 loopback Fastify HTTP 서버를 연결한다. AWS SDK, AWS CLI, ACM 상태, 공개 DNS와 ALB 외부 접속은 대역이다.

- 최초 HTTP 배포 → HTTPS 설정 → 재배포 시 HTTPS 주소 반환.
- 재배포 준비 중 HTTP/HTTPS 차단과 ECS 대상 그룹 연결 유지.
- 중지 시 HTTP/HTTPS 모두 403 확인, 재시작 시 HTTPS 복구.
- 재배포와 재시작에서 인증서 재사용, 기존 인증서 삭제 없음.
- 경로와 쿼리를 유지하는 HTTPS 리다이렉트.
- 일부 주소만 차단하는 잘못된 게이트는 인증서 요청 전에 거절.
- HTTPS 제어 서비스 장애 시 중지 성공을 보고하거나 HTTP로 새 배포를 계속하지 않음. 이 경우 443이 실제로 닫혔다고 보장하지 않는다.

엔진 검사는 원본 ALB URL 또는 HTTPS URL을 받은 뒤 등록된 HTTPS 주소를 시운전에 전달하는지 확인한다. BLOCKED에서는 로그 수집 후 AWS DELETE를 호출한다. 이 검사의 공급자 응답과 판정도 대역이다.

실제 로컬 TLS 검사는 기본 인증서 검증을 사용해 체인/SAN 성공과 잘못된 호스트·신뢰되지 않은 CA 실패를 확인했다. 공개 ACM 발급을 대신하는 검사는 아니다.

## 실제 도메인 접속

2026-10-09 23:04 KST에 `softbank.jaehwan.kr`을 읽기 전용으로 확인했다.

| 항목 | 결과 |
| --- | --- |
| DNS 주소 | `168.107.12.64` |
| HTTP GET / | 404, `nginx/1.24.0 (Ubuntu)`, Location 없음 |
| HTTPS GET / | TLS handshake 실패: `TLSV1_UNRECOGNIZED_NAME` |

이 응답을 의도한 AWS ALB의 응답이라고 확인하지 못했다. TLS handshake가 완료되지 않아 해당 도메인의 인증서 체인·SAN·만료일 검증까지 진행하지 못했다. 원본 결과는 [접속 증거](../infra/https/test/evidence/aws-domain-2026-10-09.json)에 남겼다. DNS와 AWS 리소스는 변경하지 않았다.

## 실제 AWS에서 남은 확인

해커톤 전용 CLI 프로필과 대상 ALB의 연결 정보가 확인되지 않았다. 개인 `default`/`pokeclip` 프로필은 사용하지 않았다. 다음 조건이 준비되면 서울 리전에서 실제 흐름을 이어서 확인할 수 있다.

1. 계정 `807197065061`의 전용 CLI 인증과 대상 ALB/HTTP 리스너/게이트 규칙/대상 그룹/보안그룹을 확인한다. 스택은 CloudFormation이 함께 관리하는 이 리소스들의 묶음이다.
2. DNS를 의도한 ALB로 연결하고 ACM 검증 CNAME을 등록한다. 현재 nginx 응답의 서비스 용도를 확인하기 전에는 기존 DNS를 덮어쓰지 않는다.
3. 실제 인증서 발급 → 정상 HTTPS → 경로/쿼리 리다이렉트 → 재배포 → HTTP/HTTPS 차단 → 재시작을 확인한다. 실제 시운전 결과와 CloudWatch/ALB 상태를 함께 보존한다.

AWS Target의 `httpsControlUrl`, HTTPS 설정의 `gateRuleArn`, 엔진의 `SHAKEDOWN_HTTPS_URL`은 같은 프로젝트와 제어 서비스를 가리켜야 한다. DNS/인증서 대기 중 앱 재배포를 병행하지 않는다.

## 재현 명령

통합 검증 브랜치 루트에서 실행한다. Python 환경에는 엔진 테스트 의존성이 필요하다.

```sh
npm ci
node --import tsx --test infra/https/test/*.test.ts infra/aws/test/*.test.ts
PYTHONPATH=apps/engine python -m pytest apps/engine/tests -q
npm run check:https
npm run check:aws
npm run lint:web
npm run build:web
git diff --check
```

AWS 통합 테스트는 별도 검증 브랜치에 있고, 원래 HTTPS 브랜치에는 공급자/제어 응답/엔진 수정과 회귀 검사를 반영했다. 원래 HTTPS 브랜치는 PR #21로 제출했다. PR #12가 먼저 병합되면 PR #21은 `apps/engine/engine/api.py`, `apps/web/src/app/projects/[id]/page.tsx`, `infra/aws/src/aws-provider.ts`, `infra/aws/src/config.ts`, `infra/aws/test/aws-provider.test.ts`, `packages/contracts/src/index.ts`에서 충돌하므로, 이 통합 브랜치의 해결본으로 갱신한 뒤 병합한다.
