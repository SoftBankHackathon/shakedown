# 김태윤 개발 회고 — 배포 자동화의 연결·검증·복구

작성일: 2026-10-10. 조사 기준: main `0147f4774443568becab4421ee1b7c8d86b25513`.
대상 기간: 2026-10-08~10. 대상: 김태윤의 PR #2, #5, #10, #11, #12, #29, #31과 해당 작업에 연결된 실측·결정 기록.

이 문서는 발표와 인수인계를 위한 **문제 → 원인/판단 → 선택 이유 → 수정 → 검증 → 남은 한계** 기록이다. 개인 second brain의 ADR·논의·실측 기록을 출발점으로 삼고, 공개 가능한 저장소 코드·커밋·PR·실측 보고서로 다시 대조했다. 개인 볼트의 로컬 경로, API 키, 계정별 상세 덤프는 포함하지 않는다.

기록의 “완료”는 명시한 검증 범위 안에서의 완료다. 아래 수치들은 각 실험 시점의 관측값이며 현재 전체 main을 다시 실행해 얻은 결과가 아니다. 이 문서 작성 중 유료 API·AWS 배포·장애 실험을 재실행하지 않았다.

## 1. 기여 범위와 읽는 순서

김태윤의 시작 담당은 PostgreSQL 샘플 게시판과 로컬 배포였다. 이후 **실행 엔진 연결 → 이미지 생성 → AWS 규모 판단과 배포 적용 → 보안 게이트 연동 보완 → DB 일반화 → 운영 복구 검증**으로 확장됐다.

| 구분 | 김태윤 작업 | 함께 구분할 팀 기여 |
|---|---|---|
| 로컬 기반 | PostgreSQL 샘플·Docker 이미지·Target API·유실 리허설 | 공통 API와 초기 대시보드는 팀 기반 |
| 통합 | 배포/시운전 결과를 엔진·UI에 연결, 오류 상태·DNS·취소 경계 보완 | HTTP 시운전·규칙/Claude 원인 보고서는 김태현 구현 |
| AWS | ECR/digest·AWS Target 엔진 연결, 선택 계획 적용, 결함 수정·실측 | 초기 ECS/ALB/RDS 어댑터·공유 세션 기반은 김재환 구현 |
| AI | API 설정·규칙 우선 Dockerfile fallback·소중대 판단/배포 연결 | 소스 취약점 전수검사와 AI 규모 선택 아이디어도 제안 |
| 보안 검사 | #16/#25 연동, Java 문법 회귀 수정, Tree-sitter 다국어·Go/Rust 규칙 추가 | 초기 Security Gate와 다국어 기본 보완은 김도경, 정리는 팀 기여 |
| DB·복구 | PostgreSQL URL, MySQL/Mongo 실행 계약, TLS/replica set·복원 실측 | AWS 기반을 확장한 작업이며 전체 클라우드 모듈 신규 개발은 아님 |
| 온프레미스 | EC2 모사 실험, direct 전달, systemd/Docker 자동 기동 | GCP·Azure·팀 HTTPS 자동화는 이번 개인 실측 범위 밖 |

발표용 요약은 [10절](#10-발표에서-설명할-핵심)을, 상세 문제는 3~8절을, 검증 한계는 9절을 먼저 읽으면 된다. 본문의 “대안”은 당시 결정 기록 또는 현재 구현에서 확인되는 비교다. 실제로 구현·실험한 대안은 별도로 표시하며, 모든 비교안을 벤치마크했다는 뜻은 아니다.

### 설계 선택을 한눈에 보기

| 선택 | 비교한 접근 | 선택 이유 | 감수한 제한 |
|---|---|---|---|
| 규칙 우선, LLM 1회 fallback | 모든 저장소를 처음부터 LLM에 전달 | 알려진 스택의 재현성과 실패 진단 유지 | 미지원·근거 부족이면 생성 실패 가능 |
| 카탈로그 안의 AI 판단 | 임의 IaC/자원값 생성 | 실행·권한·비용 관련 검증 범위 제한 | 소·중·대는 초기값이며 서비스별 튜닝 필요 |
| 명시적 HTTP runtime | 언어/프레임워크로 실행 설정 추측 | 포트·DB 변수·init 차이를 계약으로 표현 | 사용자가 실행 정보를 제공해야 함 |
| Tree-sitter preflight | 자체 문법 검사 또는 대상 빌드 실행 | upstream grammar 재사용, 코드 실행 없이 구문 검사 | 타입/컴파일·전체 취약점 검사는 별도 |
| 표준 URL + Secret 참조 | 자체 URL 파서·평문 환경변수 주입 | 인코딩 재사용, 자격증명과 배포 계약 분리 | 드라이버별 TLS 옵션·회전 검증 필요 |
| EC2 MongoDB | Mongo 호환 관리형 서비스 자동 대체 | 사용자 선택대로 실제 Mongo 구성 유지 | 인증서·백업·멤버 교체 운영 책임 증가 |
| ALB 연결 + 별도 차단 규칙 | listener를 고정403으로만 구성 | ECS 생성 전제와 준비 전 차단 동시 충족 | 스택 규칙·IAM·설정 동시 갱신 필요 |
| Docker restart + systemd | 재부팅 후 수동 compose up | 앱/DB와 제어 API 양쪽 자동 복구 | HA/host 유실 복구는 별도 |

## 2. PR와 의존성 타임라인

아래 개인 PR은 모두 2026-10-10 조사 시점 **MERGED**다. 오래된 보고서의 OPEN/미구현 표현은 당시 이력으로 읽어야 한다.

| PR | 머지일(KST) | 결과 | 선행 관계 |
|---|---|---|---|
| [#2](https://github.com/SoftBankHackathon/shakedown/pull/2) | 10-08 | PostgreSQL 샘플·로컬 Target·리허설 | 팀 계약에 맞춘 단독 실행 |
| [#5](https://github.com/SoftBankHackathon/shakedown/pull/5) | 10-08 | 로컬 배포·HTTP 시운전·보고서 통합 | #6~#9 시운전 머지 후 통합 보완 |
| [#10](https://github.com/SoftBankHackathon/shakedown/pull/10) | 10-09 | Local/AWS 선택·ECR/ECS 엔진 연결 | 기존 AWS 어댑터와 준비된 스택 사용 |
| [#11](https://github.com/SoftBankHackathon/shakedown/pull/11) | 10-10 | Claude 연결·이미지 생성·게이트/문법 보완 | 개발 중 #16 → #25/#26 반영 |
| [#12](https://github.com/SoftBankHackathon/shakedown/pull/12) | 10-10 | 아키텍처 적용·범용 runtime·다중 DB | 개발 당시 #11 위에 쌓은 의존 PR |
| [#29](https://github.com/SoftBankHackathon/shakedown/pull/29) | 10-10 | MySQL TLS 호스트 검증·AWS DB 복원 | #11/#12 머지 후 후속 검증 |
| [#31](https://github.com/SoftBankHackathon/shakedown/pull/31) | 10-10 | 직접 배포·재부팅 자동 기동 | EC2 모사에서 발견한 두 공백 해결 |

#31 머지 커밋은 [c924d3e](https://github.com/SoftBankHackathon/shakedown/commit/c924d3ec99abd215f0d78e65798170cdad96966e), #29는 [9781c6a](https://github.com/SoftBankHackathon/shakedown/commit/9781c6ac9d2e3a98238e7d9171be9b912e3ea661)다. 이후 main에는 팀원의 GCP·시운전 일반화·보고서 언어 변경도 들어왔다. 이 문서는 그 작업을 개인 성과에 합산하지 않는다. 과거 실측이 이후 모든 통합 변경까지 검증했다는 의미도 아니다.

## 3. 로컬에서 성공한 앱을 팀 실행 경로에 연결하기

### T01. DB를 붙여도 데이터가 사라지는 데모 — 저장소와 초기화 정책 분리

- **상황:** “RDS/PostgreSQL을 사용하면 재시작 후 데이터가 남는다”만으로는 앱 설정 오류를 설명할 수 없었다.
- **원인:** 샘플의 `demo-reset`은 `ddl-auto=create`로 시작 시 스키마를 다시 만든다. DB 외부화와 데이터 초기화 정책은 다른 문제다.
- **선택:** 정상 모드와 의도적인 초기화 오류 모드를 분리하고, 일회용 DB에서 정상 → 유실 → 정상 복귀의 7단계 리허설을 만들었다. 공유 DB에서 버그를 재현하지 않았다.
- **검증:** 가입·로그인·글 작성·목록/상세 확인과 재시작 후 유지/유실을 실제 PostgreSQL에서 확인했다. 수정은 이후 유실 방지이며 이미 삭제한 글 복구가 아니다.
- **근거:** [#2](https://github.com/SoftBankHackathon/shakedown/pull/2), [초기 인수인계](../../infra/local/HANDOFF.md), [2b2c413](https://github.com/SoftBankHackathon/shakedown/commit/2b2c4134f54dd47b3a420e4e7347fec12187bfcf).

### T02. 버튼과 모듈은 있는데 실제 배포·검사가 이어지지 않음

- **상황:** 초기 UI의 요청과 실제 실행 경로가 분리되어 있었고, 시운전 모듈이 머지되어도 기존 로컬 배포 PR은 여전히 필요했다.
- **선택/이유:** 팀 모듈을 다시 만들기보다 엔진에서 비동기 POST 접수 → 상태 폴링 → URL 전달 → 시운전 POST/GET → 증거/판정/보고서 저장을 연결했다. SQLite에 결과를 남기고 SSE로 진행을 표시했다.
- **경계 보완:** 기존 URL 두 개 비교는 `external`로 처리해 배포·삭제 대상에서 제외했다. 배포 성공 `deployed`와 검사 PASS `promoted`, WARN/BLOCKED/failed를 구분했다. 기준 환경 실패·결과 누락·모순 PASS·runner timeout은 성공으로 합성하지 않았다.
- **검증:** 당시 Engine82/Shakedown100/AWS15/Local7/Java3, 총207개 및 웹 빌드·타입 검사. 새 로컬 배포→Cloudflare→HTTP 시운전 8단계 PASS 약20.6초.
- **한계:** 당시 BLOCKED는 검사 판정이며 외부 URL의 실제 접속 차단이 아니었다. 이후 AWS 종료 경로와 팀 자동수정이 추가된 사실과 구분한다.
- **근거:** [#5](https://github.com/SoftBankHackathon/shakedown/pull/5), [통합 감사](../integration-audit-2026-10-08.md), [beac89c](https://github.com/SoftBankHackathon/shakedown/commit/beac89c4e6a5130522b8bdf3547bb1ad902f49ab), [17381d7](https://github.com/SoftBankHackathon/shakedown/commit/17381d7a04653e2da4c02b6de25b0ed827c49c15).

### T03. Target은 ready인데 시운전만 Quick Tunnel에 접속 실패

- **재현/원인:** 공개 URL 검사와 시운전 프로세스의 DNS 결과가 달랐다. 로컬 NXDOMAIN 캐시 때문에 새 trycloudflare 주소를 시운전 측에서 해석하지 못했다.
- **수정:** HTTPS trycloudflare 호스트의 DNS miss에만 제한한 fallback을 사용했다. 원래 호스트의 SNI·TLS 인증서 검증을 유지했다.
- **왜 이렇게 했나:** 모든 DNS/OS 설정을 바꾸거나 인증서 검증을 끄면 문제 범위보다 영향이 커진다. POST 재전송은 중복 쓰기를 만들 수 있어 수행하지 않았다.
- **검증:** 실패 재현 후 실제 새 배포→시운전 8단계 PASS. 시운전 마감 시 HTTP/접속 재시도를 취소하도록 보완했다. 서버가 이미 접수한 쓰기까지 취소·롤백되는 것은 아니다.
- **근거:** [통합 감사](../integration-audit-2026-10-08.md), [17381d7](https://github.com/SoftBankHackathon/shakedown/commit/17381d7a04653e2da4c02b6de25b0ed827c49c15). 팀의 후속 Cloudflare530 재시도 [#17](https://github.com/SoftBankHackathon/shakedown/pull/17)과는 별개 문제다.

### T04. 서버 두 개에서 로그인 실패 — “HTTP 200”보다 업무 흐름과 인스턴스 증거

- **상황:** 로그인 리디렉션의 최종200만으로 로그인 성공을 판단할 수 없고, 메모리 세션은 다른 인스턴스 요청에서 사라질 수 있다.
- **선택:** 팀의 공유 세션 기반을 통합하며 가입→로그인→글 작성→조회와 실제 `X-Instance-Id` hop을 기록했다. 한 서버에 붙이는 방식으로 증상을 숨기지 않고, round-robin 교차 접근을 검사했다.
- **검증:** PostgreSQL+앱2개 환경에서 메모리 세션은 8단계 BLOCKED, JDBC 공유 세션은 PASS. 앱 재시작 후 세션·글 유지와 스키마 초기화 멱등성을 확인했다.
- **기여 경계:** HTTP 시나리오·규칙/AI 보고서 원 구현은 팀원 기여다. 김태윤 작업은 실행 통합·경계 오류 보완·실제 비교 검증이다. 후속 session-jdbc 자동수정 #18도 별도 팀 작업이다.
- **근거:** [통합 감사](../integration-audit-2026-10-08.md), [인수인계](../../infra/local/HANDOFF.md).

### T05. ARM 개발 환경과 AMD64 AWS의 이미지 일치 문제

- **선택:** AWS용 Linux AMD64 이미지를 빌드하고 ECR digest를 고정해 Local/AWS에 동일 이미지 주소를 전달했다. 태그 이름이 같다는 이유만으로 같은 산출물이라고 보지 않았다.
- **세부 개선:** Java 빌드 단계는 `$BUILDPLATFORM`에서 실행하고, 실행 이미지는 목표 플랫폼에 맞춘다. Java 바이트코드의 이식성을 이용한 선택이며 네이티브 라이브러리가 있는 모든 앱에 일반화하지 않는다. 정량적 빌드 속도 개선은 측정하지 않았다.
- **별도 실험 오류:** 임시 Docker 인증 설정에서 buildx를 찾지 못해 첫 Fargate 실험이 ECS 실행 전에 중단됐다. 로컬 AMD64 빌드를 먼저 수행하도록 실험 순서를 고쳤고 실패 스택도 정리했다.
- **근거:** [#10](https://github.com/SoftBankHackathon/shakedown/pull/10), [Dockerfile 변경](https://github.com/SoftBankHackathon/shakedown/commit/95fcb1f85335aa15957c20fc405a07374641dd40), [Fargate 실험](../experiments/2026-10-09-aws-smoke.md).

## 4. AI를 어디에 쓰고 어디서 제한했나

### T06. 모든 이미지 생성을 LLM에 맡기지 않은 이유

- **요구:** 소스 분석 후 Dockerfile/이미지를 만들되 규칙으로 안 될 때 API를 호출한다.
- **선택:** 기존 Dockerfile → 지원 스택 규칙 → 규칙 실패 시 연결된 Claude 1회 fallback → 응답/구조 검증 → 별도 소스 복사본에서 빌드. 원본 저장소를 덮어쓰지 않는다.
- **이유/대가:** 알려진 프로젝트에도 API를 쓰면 비용·지연·결과 변동성이 늘어난다. 규칙만으로 모든 스택을 다룰 수 없어 fallback을 남겼다. 반대로 근거가 부족하면 실패/null을 허용하므로 모든 저장소에서 자동 생성되는 것은 아니다.
- **검증:** 실제 Flask 규칙 미지원 사례에서 fallback 응답3.679초, Docker 빌드·HTTP200 확인. 네트워크/API 제한과 실패 경로는 테스트 대역으로도 검사했다.
- **한계:** Dockerfile 구조 검사는 실행 샌드박스가 아니다. 빌드 실패마다 AI가 자동 재수정하는 루프도 아니다.
- **근거:** [bff5b80](https://github.com/SoftBankHackathon/shakedown/commit/bff5b806405b54cbd5c2956f14ec6e51326cf5dc), [c84a805](https://github.com/SoftBankHackathon/shakedown/commit/c84a805ff4e726b276e935fa06f376ae2f9f9109), [#11](https://github.com/SoftBankHackathon/shakedown/pull/11), [실제 AI 실험](../experiments/2026-10-09-live-ai.md).

### T07. “왜 규칙으로 안 됐는지”를 고정 프롬프트 계약으로 전달

- **문제:** 프로젝트 이름만 전달하면 모델이 없는 파일·명령을 추정하거나, 규칙 지원 부족을 앱 결함으로 오해할 수 있다.
- **수정:** `dockerfile-fallback.v1`에 failure 코드/단계/상세와 제한된 프로젝트 정보, 후보·누락 정보, 허용 지시문·베이스 이미지·응답 스키마를 담았다. 저장소에서 온 값은 지시가 아니라 비신뢰 데이터로 취급한다.
- **정책:** 없는 의존성·엔트리포인트·lockfile을 발명하지 않는다. 해소 불가하면 `dockerfile:null`, 응답은 Dockerfile 또는 null만 허용한다. 원본 코드/README 본문/환경변수 값을 통째로 보내지 않는다.
- **이유:** 실패 원인을 엔진이 먼저 특정하고 AI가 해결할 범위를 좁혀야 재현·거절 이유를 설명할 수 있다. 프롬프트만 믿지 않고 결과 검증기를 함께 둔다.
- **근거:** [image_prompt.py](../../apps/engine/engine/image_prompt.py), [docker_fallback.py](../../apps/engine/engine/docker_fallback.py), [8acb8eb](https://github.com/SoftBankHackathon/shakedown/commit/8acb8ebabd336db95db5b827cdc4a6b04d115cdf).

### T08. 모델 응답 형식과 API 설정의 실패를 제품 오류로 번지지 않게 처리

- **발견:** 응답 `content`가 배열이 아니거나 블록/text 타입이 잘못되면 정상적인 오류 대신 내부 예외가 날 수 있었다.
- **수정:** 응답 envelope와 블록 타입을 먼저 검증하고 빈 응답·잘린 응답·인증/429 등을 구분했다. 연결 테스트/해제와 모델 선택 UI를 제공했다.
- **선택 이유:** API 연결 성공과 생성 결과의 유효성은 별개다. 모델 ID 오타를 줄이는 UI와 provider 응답 검증이 함께 필요했다. 설정 API로 입력한 키는 엔진 메모리에 두며 문서·응답에 기록하지 않는다.
- **검증:** 비정상 envelope 회귀 테스트와 실제 API 생성1회/아키텍처3회. 당시 모델·시간은 실험 기록이지 현재 모델 제공 여부나 품질 보장이 아니다.
- **근거:** [c14c9fb](https://github.com/SoftBankHackathon/shakedown/commit/c14c9fbe5d8a92018eee391a4d91823409de4ebb), [ba6c159](https://github.com/SoftBankHackathon/shakedown/commit/ba6c1598f5e6a3cda52cc86f645225fa825e352a), [llm.py](../../apps/engine/engine/llm.py), [실제 AI 실험](../experiments/2026-10-09-live-ai.md).

### T09. AI가 임의 인프라를 생성하는 대신 소·중·대 후보를 선택

- **문제:** 소스/README에서 DB나 세션 특성은 추출해도 실제 이용자 수·피크 수요·허용 중단 시간을 확정할 수 없다.
- **선택:** 분석 근거와 사용자 운영 입력(피크RPS·가용성·트래픽 변화·우선순위)을 조합한다. 규칙 최소 등급을 계산한 뒤 AI는 허용 템플릿 ID·근거 ID·이유만 반환한다.
- **이유/대안:** 자유로운 IaC 생성보다 자원·권한·비용의 검증 범위를 제한할 수 있다. 임의 수치나 존재하지 않는 근거·최소 등급 미달 응답은 거절한다. 입력 부족 시 잠정 추천만 하고 선택 저장을 막는다.
- **실측:** small/medium/large 실제 API 응답3.876/4.551/4.434초. large 요구에서 small 선택400, large200.
- **한계:** RPS 경계와 CPU/메모리는 초기 설계 가정이다. 서비스 처리량·비용 보장이 아니며 캐시/큐/읽기 복제본을 규모만 보고 자동 생성하지 않는다.
- **근거:** [66d8da9](https://github.com/SoftBankHackathon/shakedown/commit/66d8da96e6181b34fe4e3dd188631390644c84de), [architecture.py](../../apps/engine/engine/architecture.py), [실제 AI 실험](../experiments/2026-10-09-live-ai.md).

### T10. 오래된 분석과 “선택만 됐고 실제 배포에는 미적용” 문제

- **발견:** 초기 아키텍처 기능은 추천·저장까지였고, 별도 AWS 실험은 고정 설정 Provider를 호출했다. 실험 성공이 제품 연결 완료를 뜻하지 않았다.
- **수정:** 선택 시 분석 근거 fingerprint를 재확인하고 쓰기 잠금 안에서 최신 계획을 다시 확인했다. 배포에 `architecture_plan_id`를 전달하고 프로젝트·선택 상태·근거·지원 조건을 검증한 후 서버 카탈로그 스냅샷을 실제 어댑터에 적용했다.
- **이유:** 클라이언트 임의 CPU/replica 값을 그대로 실행하지 않고, 검토한 계획과 실제 실행을 연결하려는 선택이다. 계획 저장 자체는 AWS 자원을 만들지 않는다.
- **검증:** 잘못된 프로젝트/미선택/과거 계획/직접 override/부족 AZ 거절. 실제 FastAPI TestClient→엔진 빌드/ECR→AWS에서 medium2태스크·2AZ, large3태스크·3AZ와 자원/DB/확장 설정 일치 확인.
- **한계:** fingerprint는 추출 근거 비교이며 모든 소스 바이트 동일성 보장은 아니다. 해당 실측은 use_ai=false로 배포 경로를 분리했고 브라우저 전체 E2E도 아니다. small MySQL 어댑터 실측은 이후 완료했지만 이 경로의 모든 규모 전환을 검증한 것은 아니다.
- **근거:** [a564948](https://github.com/SoftBankHackathon/shakedown/commit/a56494848686bd9be1d3e8b5bebf1521839491ef), [24e47a7](https://github.com/SoftBankHackathon/shakedown/commit/24e47a7ab07e4ebf6bb610db801105bfcded3d7d), [선택 계획 실제 배포](../experiments/2026-10-09-plan-deployment-connection.md).

## 5. 실제 AWS 호출에서 드러난 결함

### T11. ALB 접근 차단 때문에 ECS CreateService 자체가 실패

- **오류:** `The target group ... does not have an associated load balancer`.
- **원인:** 초기 listener가 고정403만 반환하고 건강 확인 후에야 target group으로 forward하도록 되어 있었다. ECS 서비스 생성 시점에 필요한 ALB-target group 연결이 없었다.
- **수정:** listener 기본 forward 연결을 유지하고 우선순위1 IPv4/IPv6 규칙으로403/forward를 전환했다.
- **선택 이유:** 준비 전 차단을 포기하지 않으면서 ECS의 연결 전제도 만족해야 했다. 기존 스택은 인입 차단 아래 규칙·권한·`GateRuleArn` 설정을 함께 갱신해야 한다.
- **검증:** 신규 스택에서 ALB 연결과 HTTP403을 동시에 확인, 실제 Provider 배포 성공. 테스트도 CreateService 전 연결, 생성 중 차단, healthy 후 개방, 중지 전 차단을 검사하도록 보완했다.
- **근거:** [980f399](https://github.com/SoftBankHackathon/shakedown/commit/980f3991ab57a3b63f68c43e2c36adeadd3f76ae), [AWS 통합 실험](../experiments/2026-10-09-aws-full-stack.md).

### T12. 정상 앱이 기동 중 unhealthy로 교체됨

- **관측:** Spring JVM 정상 기동까지 약41초, ECS health grace는30초. 서비스 이벤트에 태스크2개 교체가 남았다.
- **수정/이유:** health check를 끄지 않고 유예를120초로 늘렸다. 앱 준비 시간과 인프라 판정 시간을 맞췄다.
- **검증:** 수정 코드로 새 실험을 실행해 세션/저장 검사를 통과했다. 재배포 중 임시 증가한 태스크 수를 autoscaling으로 오인하지 않도록 desiredCount와 단일 배포 상태·확장 활동까지 판정 조건에 포함했다.
- **한계:**120초는 이 샘플의 실측을 반영한 값으로 모든 앱의 적정 기동 시간이 아니다.
- **근거:** [b46f1f9](https://github.com/SoftBankHackathon/shakedown/commit/b46f1f91ffb6c6aa517b4bb7c4e0b30d40d3a821), [AWS 통합 실험](../experiments/2026-10-09-aws-full-stack.md).

### T13. 트래픽은 막혔지만 중지 API는 502

- **관측:** medium에서403 차단은 됐지만 ECS 서비스 삭제 상태가120초 안에 수렴하지 않았다.
- **수정:** 어댑터 대기600초, 바깥 엔진 DELETE630초로 조정했다. 단순 접수 성공과 완료를 구분한다.
- **이유:** 내부 작업보다 외부 timeout이 먼저 끝나면 사용자는 실패만 보고 실제 정리 상태를 알기 어렵다. 비동기 제어 영역의 상태 수렴을 기다리되 무한 대기는 하지 않는다.
- **실측:** large에서189.70초 후204, 서비스 INACTIVE, running/pending0 확인. 이전 medium의502 기록은 성공으로 고치지 않았다.
- **한계:** 앱 중지는 RDS/ALB 등 기반 스택 삭제가 아니다. DB 변경 자동 롤백도 없다.
- **근거:** [dcfe89c](https://github.com/SoftBankHackathon/shakedown/commit/dcfe89ccc2954955ef0dd6f3bcba49f5db61eed6), [8d9b37b](https://github.com/SoftBankHackathon/shakedown/commit/8d9b37b4d388100c093467b1e0fb9a6c9946e39a), [선택 계획 실측](../experiments/2026-10-09-plan-deployment-connection.md).

### T14. 자동 확장 성공과 자동 축소 미확인을 분리

- **실측:** CPU 정책으로 desired/running2→4,96.53초에 healthy3개 이상 관측. 이후4개 정상 확인. RDS AZ 전환 후 기존 세션/쓰기 복구는71.57초.
- **미해결:** 최초16분 관측 안에 축소는 확인하지 못했다. 추가 관측 시 이미 정리 중이었으므로 유효한 재검증이 아니었다. Low alarm은60초×15기간 조건이었지만 정확한 미발생 원인은 확정하지 않았다.
- **선택:** 정책 존재나 낮은 CPU만으로 성공 판정을 하지 않았다. 후속 스크립트의20분 관측 지원도 성공 실측으로 바꾸지 않았다.
- **한계:** RDS 전환 중 실패 폴링·healthy0 구간이 있었다. 위 시간은 폴링/API 지연 포함이며 무중단·정밀 RTO 보장이 아니다.
- **근거:** [AWS 통합 실험](../experiments/2026-10-09-aws-full-stack.md).

### T15. 단순 성능 수치가 제품 용량 보장으로 오해될 위험

- **관측:** 첫 medium Fargate probe1000건 중1건 실패. 오류 종류를 기록하지 않아 원인 미확정. 같은 digest/조건 재실험1000건은 실패0이었다.
- **수정/판단:** 측정기에 실패 분류를 추가하고 최초 실패는 지우지 않았다. 전체5100건 중1건 실패로 기록했다.
- **선택 이유:** 단순 JSON endpoint의20초 실험이나 로컬200건 결과를 DB 포함 서비스 처리량·규모 확장 효과로 일반화할 수 없다.
- **한계:** large 최대12개 확장·DB병목·지속 부하는 미검증. large의 DB도 당시 db.t3.micro였다.
- **근거:** [Fargate 실험](../experiments/2026-10-09-aws-smoke.md), [실제 AI 이미지 실행](../experiments/2026-10-09-live-ai.md).

## 6. 보안 게이트 선행 조건과 오픈소스 활용

### T16. #16/#25가 먼저 들어오면서 #11/#12의 선행 조건이 바뀜

- **문제:** 이미지 생성·빌드·아키텍처 판단이 독립 동작하면 검사 전 작업이 진행될 수 있다. 초기 Python/Compose 중심 설명도 다국어 게이트 머지 후에는 맞지 않았다.
- **수정:** 계획/빌드와 아키텍처 생성/선택/resolve에 ALLOW 선행 조건을 연결했다. v3 JSON Schema는 번들 로컬 참조로만 검증하고 종료코드·판정·하위 스캐너 결과가 모순이면 SCAN_FAILED로 닫는다.
- **예외의 범위:** Compose가 없다는 `REVIEW/NOT_APPLICABLE`은 전체 ALLOW/SUCCESS, Semgrep/Gitleaks 성공 및 오류 없는 조건에서만 허용한다. 모든 REVIEW를 통과시키는 우회는 아니다. 소스/비밀 검사 coverage 조건은 유지한다.
- **macOS 경로 문제:** 엔진이 만든 임시 snapshot의 `/var`와 `/private/var` 별칭을 canonicalize했다. 사용자 경로와 스캐너의 링크 거절을 완화하지 않았다.
- **검증:** 실제 Semgrep/Gitleaks로 safe/risky Python/Java/JS/TS, Compose 없는 Java의 이미지 계획, 위험 소스로 변경한 뒤 아키텍처 거절을 확인했다.
- **근거:** [43378ae](https://github.com/SoftBankHackathon/shakedown/commit/43378aec235fe912cef2fa795cf96141d3a5ba98), [ff693dc](https://github.com/SoftBankHackathon/shakedown/commit/ff693dc032aad04e836ce2d40c589ac52fdaf2bb), [3205b2f](https://github.com/SoftBankHackathon/shakedown/commit/3205b2f5c8d5eb08d3bcfcf1535693ff40d0e851), [ecf3c60](https://github.com/SoftBankHackathon/shakedown/commit/ecf3c6008da28361729a3a2709cd4a37d6e38873), [게이트 통합 기록](../experiments/2026-10-10-security-gate-integration.md).

### T17. Java 문법 오류 테스트2개 실패 — 테스트를 약화하지 않고 스캐너 보완

- **재현:** `class Broken { void broken( {`는 SCAN_FAILED가 기대됐지만 실제 Semgrep1.180.0 연동에서 ALLOW가 나왔다. 두 실제 테스트가 같은 문제를 드러냈다.
- **조사:** Semgrep 최적화 비활성화도 해결하지 못해 해당 시도는 폐기했다. 기대값을 ALLOW로 바꾸거나 테스트를 삭제하지 않았다.
- **선택:** Tree-sitter0.25.2 + Java grammar0.23.5의 `root_node.has_error`로 Semgrep 앞에 문법 검사를 추가했다. 자체 정규식/문법 엔진 대신 기존 오픈소스를 사용했다.
- **이유:** 대상 javac/Gradle 실행은 클래스패스·의존성 다운로드·빌드 스크립트 실행에 영향을 받는다. 여기서 필요한 것은 대상 코드를 실행하지 않는 문법 사전 검사였다.
- **실패 정책:** parser 누락·crash·timeout은 통과가 아닌 SCAN_FAILED. 격리 프로세스와 시간 제한을 적용했다.
- **검증:** 두 원래 테스트의 기대값을 유지한 채 통과. braces/assignment 오류, records/sealed/switch, classpath 없는 구문, static initializer 미실행 등을 검사했다.
- **한계:** 문법 정상은 컴파일·타입·보안 안전 보장이 아니다. 고정 grammar가 새 언어 문법을 모두 지원하지 않을 수 있다.
- **근거:** [3e9ed6d](https://github.com/SoftBankHackathon/shakedown/commit/3e9ed6d68a9de2c3a537acb9487da1ef49c739b5), [게이트 기록](../experiments/2026-10-10-security-gate-integration.md), [source_syntax.py](../../apps/security-gate/security_gate/source_syntax.py).

### T18. 다국어 파서와 취약점 검사를 혼동하지 않기

- **구현:** Python은 ast.parse, Java 외 JS/JSX·TS/TSX·Go·Rust·C/C++·C#·Ruby·PHP에 upstream grammar를 연결했다. HTML/SVG 추출 스크립트는 실제 JS/TS suffix로 검사하고 `.h`는 C 또는 C++ 구문을 허용했다.
- **정책:** 문법만 지원하는 언어는 유효하더라도 보안 규칙 부족으로 REVIEW, 문법 오류는 SCAN_FAILED다. 혼합 저장소의 미지원 파일도 숨기지 않는다.
- **Go/Rust 확장:** upstream Semgrep 규칙3개를 원본 그대로 고정했다. Go는 동적 executable/문자열 SQL, Rust는 Result 함수의 unwrap/expect audit이다. 소스 커밋·해시·라이선스를 함께 보존한다.
- **이유/대가:** 자체 규칙을 급히 늘리는 대신 범위와 출처가 명확한 규칙을 재사용했다. Rust audit 탐지는 곧바로 악용 가능 취약점 확정이 아니며 검토용 DENY다. 의존성 CVE 검사는 포함하지 않는다.
- **검증:** 언어/확장자·혼합 소스·크기 제한·실제 parser/스캐너·규칙 hash 검사. 당시 gate427 passing/Windows 전용1 skip, #11 engine207 통과. C/C++/C#/Ruby/PHP는 syntax-only REVIEW 유지.
- **라이선스:** Go vendor는 MIT 저장소 및 Apache-2.0 파일 고지, Rust 규칙은 AGPL-3.0. 배포 시 해당 고지를 보존해야 한다.
- **근거:** [a6f463a](https://github.com/SoftBankHackathon/shakedown/commit/a6f463a166eae7415b6b75fafe845739d2f804e3), [117d1df](https://github.com/SoftBankHackathon/shakedown/commit/117d1dfb820233fd203212882d02a1e8c7e8c676), [vendor README](../../apps/security-gate/semgrep_rules/vendor/README.md), [manifest](../../apps/security-gate/semgrep_rules/vendor/manifest.json).

### T19. Java 지원 보완 후에도 기존 게시판이 REVIEW

- **관측:** 당시 실제 게시판은 Java/JS30파일 검사와 Gitleaks ALLOW, 검증된 wrapper JAR1개 제외까지 진행했지만 `EXTERNAL_SCRIPT_REFERENCE`, `TEMPLATE_EXPRESSION` coverage gap이 남았다.
- **판단:** “Java 파서 수정 완료”를 “기존 데모 전체 배포 허용”으로 바꾸지 않았다. 파서 수정과 검사 범위 충족은 별개다.
- **상태:** 해당 스캔 시점의 결과다. 최신 main 전체를 이번 문서 작업에서 다시 스캔하지 않았으므로 현재도 동일하게 실패한다고 단정하지 않는다. 후속 변경이 있으면 동일 입력·도구 버전·검사 결과로 갱신해야 한다.
- **근거:** [게이트 통합 기록](../experiments/2026-10-10-security-gate-integration.md).

## 7. 언어를 늘려도 실제 배포와 DB 연결이 자동으로 넓어지지는 않음

### T20. Spring/PostgreSQL 가정이 DB 없는 앱까지 따라옴

- **문제:** parser 지원을 늘려도 앱마다 포트·health·DB 변수·초기화 명령이 다르다. 언어 이름만으로 실행 설정을 추측하면 잘못된 DB를 만들거나 시작하지 못한다.
- **선택:** `http-runtime.v1`에 단일 HTTP 컨테이너의 port/health/env/DB mode/binding/init argv를 명시한다. 미지정은 기존 샘플 호환 경로, `none`은 DB/RDS 작업 생략, `external`은 기존 비밀 참조 사용이다.
- **이유:** 특정 프레임워크를 모두 탐지하려 하기보다 배포 어댑터가 실행할 공통 계약을 정의했다. DB 드라이버/쿼리를 자동 변환하지 않는다. 초기화 실패 시 배포를 중단하고 runtime 변경은 이전 아키텍처 선택을 무효화한다.
- **검증:** Node/Python × DB없음/PostgreSQL 실제 로컬4조합, 이후 Node DATABASE_URL을 더한5조합 HTTP200. 초기화2회와 특수문자/Unicode 비밀번호도 확인했다.
- **한계:** 단일 HTTP workload 중심이다. 워커/배치/다중 앱 컨테이너/임의 영속 볼륨까지 지원한다는 뜻이 아니다. Go/Rust도 기존 Dockerfile과 명시적 runtime이 필요할 수 있다.
- **근거:** [496582b](https://github.com/SoftBankHackathon/shakedown/commit/496582b4a42aa205fcd9f159247d451c0b732fb9), [실행 계약](../http-runtime.md), [언어/DB 감사](../experiments/2026-10-10-language-db-audit.md).

### T21. Go/Rust 등의 DATABASE_URL을 자동 생성하지 못함

- **원인:** 기존 binding은 host/port/name/user/password/JDBC 중심이고 `postgres_url`이 없었다. URL 생성보다 실제 엔진 검증·Secret 주입까지 연결하는 계약이 빠져 있었다.
- **선택:** 표준 Node WHATWG URL 처리로 포맷/인코딩을 재사용하고 프로젝트 고유 binding/비밀 참조/수명 정책만 구현했다. 자체 URL 파서·드라이버·암호화를 만들지 않았다.
- **AWS 연결:** 전용 URL Secret 갱신 후 ECS에서 불변 버전을 참조한다. 비밀번호 포함 URL을 일반 environment/응답/로그에 싣지 않는다. 로컬은 비공개 환경 설정을 사용한다.
- **검증:** 특수문자·Unicode 자격증명 및 Node DATABASE_URL 실제 연결, 계약·비밀값 노출 방지 테스트. 뒤의 MySQL/Mongo AWS 실측에서도 URL Secret 경로를 확인했다. 모든 드라이버의 옵션 호환성/회전을 실측한 것은 아니다.
- **근거:** [ac6921b](https://github.com/SoftBankHackathon/shakedown/commit/ac6921b38428ed7765d9e29d860266a6085bb0b6), [runtime.mjs](../../packages/contracts/runtime.mjs), [언어/DB 감사](../experiments/2026-10-10-language-db-audit.md), [로컬 증거](../experiments/evidence/2026-10-10-postgres-url-runtime.json).

### T22. DB 감지·사용자 선택 충돌과 외부 Secret 권한 누락

- **감사 재현:** none+PostgreSQL 감지와 postgres+MySQL 감지가 허용되고, external+MongoDB는 RDS 기준으로 잘못 차단됐다.
- **수정:** DB 의도 충돌은 계획·실제 빌드 단계에서 차단하고 external은 관리형 RDS 검사에서 분리했다. 소스 감지가 확정 사실이라고 간주하거나 DB를 자동 변환하지 않았다. SQLite/로컬 파일 위험도 external만 선택했다고 해결 처리하지 않는다.
- **IAM 문제:** config의 외부 Secret ARN 전달은 가능했지만 execution role은 생성된 DbSecret만 읽을 수 있었다. 정확한 외부 Secret/KMS ARN을 받는 조건부 스택 파라미터를 추가했다.
- **선택 이유:** URL 전달 성공과 네트워크/권한/DB 사용 성공은 별개다. 광범위 `*` 권한 대신 필요한 리소스만 지정한다. 기존 스택 갱신과 설정 재생성이 필요하다.
- **검증/한계:** 후속 엔진275/로컬10/AWS SDK33, lint/build 통과. 당시 실제 외부 DB/IAM AccessDenied 실험은 하지 않았다. 후속 관리형 DB 실측으로 임의 외부 DB까지 검증했다고 주장하지 않는다.
- **근거:** [ac6921b](https://github.com/SoftBankHackathon/shakedown/commit/ac6921b38428ed7765d9e29d860266a6085bb0b6), [언어/DB 감사](../experiments/2026-10-10-language-db-audit.md).

### T23. MySQL/MongoDB 추가 — 문법 변환이 아닌 DB별 실행·연결 구성

- **요구/선택:** 사용자 요청으로 PostgreSQL 외 MySQL/MongoDB를 추가했다. 로컬은 공식 DB 이미지, AWS 관계형 DB는 RDS, MongoDB는 사용자가 선택한 EC2 직접 구성이다. DocumentDB로 자동 대체하지 않았다.
- **이유/대가:** DB별 프로토콜과 초기화·계정·TLS 옵션은 다르다. 공통 계약 안에 차이를 명시하고 공식 드라이버/SDK를 활용했다. EC2 Mongo는 운영·인증서·백업·복구 부담이 추가된다.
- **검증:** 로컬 실제 쓰기/읽기·DB 재시작·잘못된 비밀번호 거절·Mongo 앱 계정 관리자 작업 거절. AWS Mongo medium2앱 태스크, MySQL small ECS 실제 배포와 Unicode 쓰기/읽기.
- **한계:** 기존 DB 엔진 변경/데이터 마이그레이션이나 앱 SQL/드라이버 자동 수정은 아니다. MongoDB Community의 SSPL 등 사용 구성의 라이선스도 별도로 유지한다.
- **근거:** [fa50609](https://github.com/SoftBankHackathon/shakedown/commit/fa5060986b6e2f3c3811b8b16acf34530ae1d37d), [관리형 DB 문서](../managed-databases.md), [로컬 DB 증거](../experiments/evidence/2026-10-10-mysql-mongodb-runtime.json), [DB 실제 검증](../experiments/2026-10-10-database-live-validation.md).

### T24. MongoDB 초기화가 세 번째 멤버보다 먼저 실행됨

- **실패/원인:** 3AZ EC2의 시작 시간 차이로 `rs.initiate` 시 세 번째 Mongo 프로세스가 아직 접근 불가했다.
- **수정:** 초기화에 재시도를 추가했다. 처음에는 같은 노드에서 SSM으로 수정 구간만 재실행해 성공했으므로 전체 신규 생성 성공이라고 쓰지 않았다.
- **후속 검증:** #29 실험에서 새3AZ 스택을 생성해 SSM 초기화 재실행 없이 bootstrap 완료, 실제 어댑터로 ECS앱2개 배포 성공. 이 후속 증거로 신규 스택 미검증 항목을 닫았다.
- **선택 이유:** 단순 고정 sleep보다 실제 준비 시간 차이에 대응하는 재시도가 필요했다. 부분 재실행과 처음부터 재현은 다른 검증이다.
- **근거:** [Mongo 장애 실험](../experiments/2026-10-10-mongodb-tls-failover.md), [후속 신규 스택 검증](../experiments/2026-10-10-database-live-validation.md).

### T25. MongoDB TLS와 primary 장애 전환

- **구성:** 3AZ/3EC2 replica set, 암호화EBS, TLS필수·CA/IP SAN 검증, 멤버 인증, 앱 전용 계정. URI Secret과 init container의 CA read-only 볼륨을 사용한다. 앱에 관리자 비밀번호/서버 private key를 주지 않는다.
- **선택 이유:** 연결 암호화만으로 가용성이 생기지 않고 replica set만으로 암호화가 생기지도 않는다. 두 요구를 별도로 구현·실험했다. Mongo 멤버3개는 앱 small/medium/large와 별개다.
- **실측:** 정상CA 연결 성공, CA없는 연결 거절. 평문은12초 내 성공 없이 timeout. primary EC2중지 후 새 primary쓰기2.13초, 프로세스SIGKILL 후12.24초(HTTP실패2회), 선택한 장애 전 문서 보존·3멤버 복귀.
- **한계:** 표본·SSM/API 지연 포함. hostname mismatch 음성 실험의 실패 원인은 분리하지 못해 확증으로 쓰지 않는다. 두멤버 장애·EC2자동교체·인증서자동갱신·sharding·무중단은 검증/구현 성과에 넣지 않는다.
- **근거:** [Mongo 실험](../experiments/2026-10-10-mongodb-tls-failover.md), [JSON 증거](../experiments/evidence/2026-10-10-mongodb-tls-failover.json).

### T26. MySQL “TLS 연결 성공”만으로 호스트 검증을 보장할 수 없음

- **발견:** mysql2는 인증서 체인 검증과 hostname 검증을 별도로 다룬다. 공통 URL에 `rejectUnauthorized`와 `verifyIdentity`를 명시했다.
- **음성 테스트 문제:** 의도적으로 틀린 TLS host의 연결이 거절됐지만 probe는 원래 Node 오류코드를 기대해서 실패로 오분류했다. mysql2가 `HANDSHAKE_SSL_ERROR`로 감싸므로 구체적인 hostname mismatch 메시지를 확인하도록 고쳤다.
- **선택 이유:** 임의 TLS 실패를 호스트 검증 성공으로 간주하지 않고, 정상CA 연결은 성공·잘못된 호스트는 해당 이유로 실패하는 두 조건을 확인해야 한다.
- **실측:** RDS MySQL8.4.7 + mysql2 3.24.5, TLS_AES_256_GCM_SHA384 및 Unicode 쓰기, 잘못된 호스트명 거절. 이미지 다시 빌드 후 실제 검증 통과.
- **한계:** mysql2 경로의 실측이다. 모든 JDBC/언어 드라이버의 동일 옵션 호환성을 보장하지 않는다.
- **근거:** [#29](https://github.com/SoftBankHackathon/shakedown/pull/29), [DB 실제 검증](../experiments/2026-10-10-database-live-validation.md), [database-url 테스트](../../infra/aws/test/database-url.test.ts).

### T27. 백업 파일 존재와 복원 가능성, 자동화 권한을 따로 검증

- **제약:** AWS Backup 권한/키 관련 거절 후 DLM도 조직 SCP로 명시 거절됐다. 권한 확대나 다른 스케줄러로 우회하지 않고 Mongo 자동 스냅샷을 비활성화한 실험으로 범위를 제한했다.
- **MySQL 실측:** 암호화 자동 스냅샷 available 관측. 수동 스냅샷을 별도 private RDS로 복원하고 URL Secret을 새 endpoint로 재생성/버전고정해 재배포했다. 원래 UUID/Unicode 행 조회와 새 쓰기를 확인했다.
- **Mongo 실측:** 정상 종료한 보조 노드 EBS를 snapshot→새 암호화 볼륨으로 복원. XFS `nouuid`로 마운트하고 네트워크 없는 별도 standalone Mongo에서 원문서·새 쓰기/읽기를 확인했다. 원본 replica set에 복원 노드를 합류시키지 않았다.
- **이유:** 백업 생성 성공만으로 복구를 증명할 수 없다. 원본을 덮어쓰면 복원 검증 자체가 장애가 되므로 격리된 새 대상에서 확인했다.
- **남은 것:** Mongo 예약 자동백업은 여전히 불가/미검증. PITR·장기보존·전체 replica set 재구성은 수동 단일 복원과 다르다. MySQL 자동 snapshot에서의 복원까지 수행했다고 표현하지 않는다(복원 대상은 수동 snapshot).
- **근거:** [DB 실제 검증](../experiments/2026-10-10-database-live-validation.md), [JSON 증거](../experiments/evidence/2026-10-10-database-live-validation.json).

## 8. 온프레미스 이식성과 서버 재부팅

### T28. EC2에서 수동 실행 성공 ≠ 제품의 직접 배포 지원

- **초기 실험:** EC2에 Docker/Compose로 앱과 DB를 실행했다. 기존VPC/IGW/기본route+공인IP, 앱18080만 시험클라이언트/32에 열고 SSM으로 관리했다. ECS/RDS/Cloudflare는 쓰지 않았다.
- **발견:** 기존 runtime은 cloudflared와 Tunnel health를 필수로 기다렸다. 최초 실험은 생성 Compose에서 터널을 빼고 포트를 더한 수동 조정이므로 제품 API 지원이 아니었다.
- **수정:** `LOCAL_DELIVERY_MODE=direct`와 운영자 지정 URL/bind/port 설정을 추가했다. direct에는 tunnel 컨테이너·tunnel 로그 조회가 없다. 실제 지정 공개URL의200을 확인한다.
- **엔진 보완:** 기존 tunnel URL 조건을 무조건 완화하지 않고 정확한 설정 origin만 허용한다. URL에 임의 경로/자격증명·다른 host를 허용하지 않는다. 주소당 한 미삭제 배포를 예약하고 충돌409, 동일 요청은 멱등 처리한다. 실패 배포도 자원을 소유할 수 있어 DELETE 전까지 예약한다.
- **실측:** 새 EC2에서 생성 Compose 수동 편집 없이 POST/GET/logs/DELETE로 DB없는앱·Node/PG 배포. 외부HTTP와 경쟁409 확인.
- **한계:** IGW는 이 공인EC2 실험의 인터넷 통신 경로다. 실제 사내LAN-VPC 연결/VPN/Direct Connect와 동일하지 않다. HTTPS 도메인 발급은 이 실험에 포함되지 않았다.
- **근거:** [초기 모사](../experiments/2026-10-10-onprem-ec2.md), [후속 제품 API 검증](../experiments/2026-10-10-direct-deployment-reboot.md), [delivery.mjs](../../infra/local/delivery.mjs).

### T29. 데이터는 남았는데 재부팅 후 서비스가 올라오지 않음

- **초기 관측:** 실제 boot ID가 바뀐 재부팅 뒤 실행 컨테이너가0이었다. 수동 compose up 뒤 데이터2건은 남았다. 영속 볼륨과 자동 기동은 별도 문제였다.
- **수정:** 생성 app/DB/tunnel에 `restart: unless-stopped`, Docker 이후 loopback Target API를 시작하는 systemd unit을 추가했다. 환경 파일은 root0600, 상태는 디스크에 보존한다.
- **선택 이유:** 컨테이너만 재기동되면 제어 API가 사라지고, API만 재기동되면 실제 앱이 내려가 있을 수 있다. 두 계층을 함께 관리한다. 사용자가 명시적으로 멈춘 서비스를 무조건 부활시키지 않는 정책을 사용했다.
- **실측:** 실제 EC2 재부팅 후 새POST/수동시작 없이 API·Node앱·PG 자동 복구, 데이터2건·외부HTTP 유지. 그 뒤 DELETE→두 번째 재부팅에서 컨테이너 미부활·GET404 tombstone·DB볼륨 보존 확인. 마지막에 시험 볼륨도 명시 삭제했다.
- **한계:** Docker host재부팅은 Compose health dependency를 다시 순서대로 보장하지 않는다. 앱 DB 재시도 또는 실패 종료가 필요하며 살아 있는 unhealthy 프로세스는 별도 회복 로직이 필요하다. 기존 배포는 재배포해야 정책을 얻는다. systemd unit이 엔진까지 설치/시작하지는 않는다.
- **검증 범위:** 엔진421/로컬16, 최종 URL port 수정 관련12개 재실행. 실제 host재부팅은 Node/PG만 수행, MySQL/Mongo는 정책·설정 테스트와 앞선 DB재시작 검증이지 동일 host재부팅 실측이 아니다.
- **근거:** [#31](https://github.com/SoftBankHackathon/shakedown/pull/31), [후속 실측](../experiments/2026-10-10-direct-deployment-reboot.md), [systemd unit](../../infra/local/systemd/shakedown-local.service), [URL 회귀 테스트](../../apps/engine/tests/test_local_direct_url.py).

### T30. 실험 도구의 오류와 실제 제품 실패를 구분하고 정리 결과를 독립 확인

| 관측 | 분류 | 대응 및 판정 |
|---|---|---|
| Docker checksum manifest의 `*filename` 처리 실패 | EC2 설치 harness 오류 | parser 수정·정상 checksum 검증 후 SSM 재개. 최초 완전 무인 bootstrap 성공 주장은 하지 않음 |
| Python CA store가 IP조회 HTTPS 인증서를 검증 못함 | 실험 환경 오류 | 인증서 검증을 유지하는 시스템 curl 사용. TLS검증 비활성화 안 함 |
| delete-volume 성공의 빈 응답을 JSON으로 파싱하다 실패 | 정리 wrapper 오류 | SSM 결과와 EC2 자원 부재를 별도로 확인, 남은 snapshot 정리 |
| 자동 확장 대상 재삭제 ObjectNotFound | 정리 단계 중복/상태 수렴 | 최종 대상·정책·알람 부재 확인. 오류 자체를 지우지 않음 |
| 관측 연장 중 stop-task timeout | 실험 감독/정리 상호작용 | 정리 재개 후 스택/독립 목록 확인. cleanup_errors=0이라고 쓰지 않음 |

자원 정리는 실험 성공과 별도 합격 조건이다. 앱 stop만으로 RDS/ALB/EBS/ECR/Secret 비용이 끝나지 않는다. 실패 스택과 보존 정책 자원도 실험 소유권을 확인하고 제거했다. 온프레미스 모사에서는 공유 VPC/IGW는 보존했다. 예산은 최초$3에서 사용자 증액 허용이 있었으나, 계산상 추정액을 확정 청구액으로 기록하지 않았다.

근거: [AWS 통합 실험](../experiments/2026-10-09-aws-full-stack.md), [Mongo 실험](../experiments/2026-10-10-mongodb-tls-failover.md), [DB 복원](../experiments/2026-10-10-database-live-validation.md), [EC2 초기 실험](../experiments/2026-10-10-onprem-ec2.md).

## 9. 검증 수준과 남은 작업

### 9.1 성공 주장의 범위를 고정하기

| 증거 종류 | 확인한 것 | 대신하지 못하는 것 |
|---|---|---|
| 엔진/API 자동 테스트 | 계약·오류·상태·정책 거절 | 실제 AWS IAM/네트워크·실서비스 성능 |
| 실제 Semgrep/Gitleaks/Tree-sitter | 도구 연동·선택된 규칙·문법·coverage 처리 | 모든 언어 취약점·CVE·컴파일 안전 |
| 실제 로컬 컨테이너 | 이미지 실행·DB연결·init·영속성 | 모든 언어 드라이버·클라우드 운영 |
| 실제 Claude 호출 | 생성1회·판단3회·생성 이미지 실행 | 모델 품질 분포·모든 repo 성공·현재 모델 가용성 |
| FastAPI TestClient→실제 AWS | 선택 계획 배포 실행 경로 | 실제 브라우저·LLM·보안게이트 통합 E2E |
| AWS 어댑터 DB·장애/복원 실험 | 해당 DB·드라이버·장애 조건의 관측 | HA/SLA·PITR·모든 장애·최소IAM |
| EC2 host재부팅 | Node/PG 자동 기동·삭제 상태 유지 | 실제 사내망·host상실 복구·다른 DB reboot |

실험별 테스트 수를 합산해 “신규 테스트 N개”로 표현하지 않는다. 같은 회귀 테스트가 여러 번 포함된다. 437개는 #31 시점 엔진421+로컬16이며 보안 게이트427개나 이전207개와 단순 합산할 수 없다.

### 9.2 발표/운영 전에 남겨야 할 제한

- Mongo 자동백업 스케줄: 조직SCP 제약 유지. 수동 복원과 별개.
- AWS 자동 scale-in, 최소 IAM만의 배포, 버전교체·실패복구, 대표부하·DB병목, 규모 축소 전환: 전체 검증 완료로 주장하지 않음.
- 전체 UI→검사→LLM→선택→배포→시운전→중지의 같은 실행에 대한 E2E는 위 분리 실험들을 합쳤다고 자동 성립하지 않음.
- 파서/규칙 지원, Dockerfile 생성, HTTP runtime, DB driver 호환성은 서로 다른 지원 축. “전체언어·모든 서비스 지원”이 아님.
- AWS 계정 연결·기반 스택 provisioning은 운영자 준비가 필요. 임의 빈 계정의 완전 자동 온보딩이 아님.
- direct 모드의 안정 주소·방화벽·TLS 운영, 앱 DB 재접속, 인증서 갱신·Mongo 멤버 교체는 별도 운영 사항.
- 보안 게이트 ALLOW와 생성 Dockerfile 검증은 서비스의 운영 보안 인증이 아님. 초기 샘플 권한/CSRF/요청제한 등 감사 항목은 이 회고에서 해결됐다고 판정하지 않음.
- 팀원이 추가한 HTTPS/GCP/Azure 기능의 존재와 김태윤 개인 실측 범위를 구분. “이번에 미검증”을 “팀 제품에 기능 없음”으로 바꾸지 않음.

## 10. 발표에서 설명할 핵심

**역할:** “소스 분석 결과를 실제 배포로 연결하고, 다른 환경에서도 앱과 DB가 실행·복구되도록 만드는 부분을 담당했습니다.”

**선택 근거:** “예측 가능한 부분은 규칙과 표준 라이브러리로 처리했습니다. AI에는 규칙이 해결하지 못한 문제와 허용된 아키텍처 후보만 전달했고, 결과는 실행 전에 다시 검증했습니다.”

**대표 트러블슈팅 세 가지:**

1. ALB 차단 정책 때문에 ECS 생성이 실패했다. 대상 연결과 공개 차단을 분리해 둘 다 만족시켰다(T11).
2. Semgrep이 잘못된 Java 구문을 통과시켰다. 테스트 기대값을 낮추지 않고 Tree-sitter 사전 검사로 보완했다(T17).
3. EC2에서 데이터는 남았지만 앱이 재부팅 후 안 올라왔다. 컨테이너 정책과 제어 API 자동기동을 함께 구현하고 삭제 후 재부팅도 검사했다(T29).

**검증 태도:** “HTTP200 하나만 보지 않고 세션·쓰기/읽기·인스턴스·실제 AWS 상태를 확인했습니다. 해결되지 않은 scale-in이나 자동백업 제약은 성공 사례와 분리해 기록했습니다.”

## 11. 근거 찾아가기와 조사 범위

### 공개 근거 색인

| 근거 | 활용 범위 |
|---|---|
| [PR #2](https://github.com/SoftBankHackathon/shakedown/pull/2), [Local 인수인계](../../infra/local/HANDOFF.md) | T01·T04·초기 API 계약 |
| [PR #5](https://github.com/SoftBankHackathon/shakedown/pull/5), [통합 감사](../integration-audit-2026-10-08.md) | T02~T04 |
| [PR #10](https://github.com/SoftBankHackathon/shakedown/pull/10), [엔진 README](../../apps/engine/README.md) | AWS 최초 연결·설정 전제 |
| [실제 AI](../experiments/2026-10-09-live-ai.md), [Fargate smoke](../experiments/2026-10-09-aws-smoke.md) | T05~T09·T15 |
| [AWS full-stack](../experiments/2026-10-09-aws-full-stack.md), [선택 계획 실측](../experiments/2026-10-09-plan-deployment-connection.md) | T10~T14 |
| [게이트 통합](../experiments/2026-10-10-security-gate-integration.md), [언어/DB 감사](../experiments/2026-10-10-language-db-audit.md) | T16~T22 |
| [runtime 계약](../http-runtime.md), [DB 계약](../managed-databases.md) | 실행·binding·비밀참조·운영 전제 |
| [Mongo 실측](../experiments/2026-10-10-mongodb-tls-failover.md), [DB복원 실측](../experiments/2026-10-10-database-live-validation.md) | T23~T27 |
| [EC2 모사](../experiments/2026-10-10-onprem-ec2.md), [직접배포·reboot](../experiments/2026-10-10-direct-deployment-reboot.md) | T28~T30 |
| [HTTP runtime JSON](../experiments/evidence/2026-10-09-http-runtime.json), [PG URL JSON](../experiments/evidence/2026-10-10-postgres-url-runtime.json) | 실제 로컬4/5조합 |
| [DB복원 JSON](../experiments/evidence/2026-10-10-database-live-validation.json), [direct JSON](../experiments/evidence/2026-10-10-direct-deployment-reboot.json) | 데이터/상태/정리 증거 |

### 회귀 검증 코드 찾아가기

아래는 코드와 실행 방법을 찾아가기 위한 색인이다. 문서 작성 시 재실행 결과를 뜻하지 않는다. 클라우드 실험은 별도 폐기용 자원·자격증명·비용 범위가 필요하므로 단위 테스트와 구분한다.

| 관심 문제 | 확인할 코드/테스트 |
|---|---|
| 이미지 규칙·fallback·생성 계약 | [test_image_builder.py](../../apps/engine/tests/test_image_builder.py) |
| 분석 근거·계획 선택·규모 조건 | [test_architecture.py](../../apps/engine/tests/test_architecture.py) |
| AWS 오케스트레이션·실패 정리 | [test_aws_deployments.py](../../apps/engine/tests/test_aws_deployments.py) |
| 실제 게이트와 엔진 경계 | [test_security_real.py](../../apps/engine/tests/test_security_real.py), [test_security_integration.py](../../apps/engine/tests/test_security_integration.py) |
| Java 문법·다국어·vendor 출처 | [test_java_support.py](../../apps/security-gate/tests/test_java_support.py), [test_source_syntax.py](../../apps/security-gate/tests/test_source_syntax.py), [test_vendored_rules.py](../../apps/security-gate/tests/test_vendored_rules.py) |
| runtime DB 충돌·바인딩 | [test_runtime.py](../../apps/engine/tests/test_runtime.py), [database-url.test.ts](../../infra/aws/test/database-url.test.ts) |
| AWS 리소스 적용 | [architecture-deploy.test.ts](../../infra/aws/test/architecture-deploy.test.ts), [aws-provider.test.ts](../../infra/aws/test/aws-provider.test.ts) |
| direct URL·서비스 수명주기 | [test_local_direct_url.py](../../apps/engine/tests/test_local_direct_url.py), [delivery.test.mjs](../../infra/local/test/delivery.test.mjs), [service.test.mjs](../../infra/local/test/service.test.mjs) |
| 실제 DB 없는 앱/PG 연결 | [smoke-runtime.mjs](../../infra/local/smoke-runtime.mjs) |
| 실제 MySQL/Mongo 연결 | [smoke-databases.mjs](../../infra/local/smoke-databases.mjs) |
| 실제 AWS 선택 계획 | [plan-deployment-check.py](../../infra/aws/experiments/plan-deployment-check.py) |
| 실제 재부팅 전/후·삭제 검증 | [direct-api-reboot.py](../../infra/local/experiments/direct-api-reboot.py) |

### 과거 기록을 현재 결과로 읽는 방법

| 과거 문구 | 후속 결론 | 여전히 남는 구분 |
|---|---|---|
| 선택 계획 실제 배포 미구현 | T10의 medium/large 실제 엔진 경로 검증 완료 | 전체 브라우저/LLM E2E와 다름 |
| Java 오류 테스트2개 실패 | T17의 parser 보완 후 원래 기대값 통과 | T19의 template/external script coverage는 별개 |
| DATABASE_URL 생성 없음 | T21에서 binding/Secret 경로 추가 | 모든 DB 드라이버·external 실연결 보장은 아님 |
| AWS MySQL 실배포/복원 미검증 | T26/T27에서 RDS 실제 연결·수동 snapshot 복원 확인 | Multi-AZ failover·PITR와 다름 |
| Mongo 새 스택 bootstrap 미검증 | T24의 후속 신규 생성 완료 | 예약 자동백업 SCP 제약 유지 |
| 온프레미스 수동 Compose·수동 재기동 | T28/T29에서 제품 API direct·실제 자동 reboot 확인 | 실제 사내망/다른 DB host재부팅은 별도 |
| #11/#12/#29/#31 OPEN | 개인 PR 모두 MERGED | 이 회고 문서 PR의 머지 상태와는 별개 |

### 이번 조사에서 한 것과 하지 않은 것

- 개인 PR7건의 상태·작업 이력과 김태윤 authored non-merge 커밋 목록을 확인했다. 주요 수정 diff와 현재 구현·테스트 위치를 대조했다.
- 개인 결정 기록5건, 구조·논의·실측 노트, 저장소의 관련 실측/감사 보고서 전체를 대조했다. 이전 문서의 미구현/미머지/미검증을 후속 결과와 연결했다.
- 공개 JSON은 근거 링크로 보존한다. 과거 민감한 원시 클라우드 덤프 전체를 공개하거나 모든 실행 로그가 완전 보존됐다고 주장하지 않는다.
- 과거 원인 미확정 현상에는 추정 원인을 추가하지 않았다. 새 부하/장애/유료 실행을 하지 않았으며 수치는 기존 실측의 범위·시점과 함께 옮겼다.
- 저장소 전체 운영 보안 감사가 아닌 개인 작업의 근거 기반 회고다. 최신 팀 코드까지 전면 검증한 보증 문서가 아니다.
