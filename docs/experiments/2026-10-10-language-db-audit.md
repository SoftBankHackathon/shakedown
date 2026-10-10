# 다국어 보안 및 DB 런타임 점검 — 2026-10-10

## 완료한 변경

Go/Rust 문법 검증 이후 고정된 공개 Semgrep 규칙을 적용한다. Go는 동적 실행 파일·문자열 결합 SQL, Rust는 Result 반환 함수의 unwrap/expect audit만 검사한다. 원본 규칙, 커밋/해시, 라이선스는 apps/security-gate/semgrep_rules/vendor에 보관했다. 이 범위에서 미탐지는 ALLOW, 탐지는 DENY이며 전체 취약점 보장이 아니다. 의존성 CVE 검사는 포함하지 않는다.

게이트 426 passed / 1 Windows-only skip + 별도 provenance 테스트 1 passed. 엔진 #11 207 passed, #12 267 passed. 로컬 어댑터 9 passed, AWS 어댑터 27 passed. AWS 테스트는 SDK 경계 테스트이며 실제 배포/접속 검증이 아니다. 이번 작업에서 AWS 리소스를 생성하지 않았다.

## 확인한 정상 계약

composeSpec/validateRuntime/DockerRuntime.resolved로 synthetic 요청을 확인했다.

| DB 모드 | 로컬 DB 서비스 | 로컬 DB 볼륨 | 환경변수 |
| --- | --- | --- | --- |
| none | 없음 | 없음 | PORT, TZ |
| postgres | 생성 | 생성 | 설정한 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD |
| external | 없음 | 없음 | 등록된 DATABASE_URL secret 참조, PORT, TZ |

AWS 어댑터 회귀 테스트는 DB 없음과 관리형 PostgreSQL의 분기, 초기화 실패 중단, 환경변수와 Secret 전달 계약을 검증한다. 실제 외부 DB 연결, 외부 Secret IAM 권한 및 네트워크 접근성은 이 테스트로 보장되지 않는다.

## 최초 감사 결과 (아래 후속 수정 전)

1. **관리형 PostgreSQL URL 자동 생성 없음.** engine/runtime.py의 바인딩은 host/port/name/username/password/jdbc_url만 허용한다. `DATABASE_URL: postgres_url`은 Pydantic 검증에서 거절된다. 이미 만들어 둔 URL을 external + secret_refs로 전달하는 경로는 있다. Node 표준 URL API로 포맷/인코딩을 처리하고, 로컬은 private 환경 설정, AWS는 Secrets Manager + ECS secret 참조로 연결하는 작업이 필요하다. URL에 포함된 비밀번호를 일반 task environment/응답/로그에 넣으면 안 된다. 암호 회전 후 URL 갱신과 태스크 재시작 정책도 정의해야 한다.

2. **DB 의도와 감지 결과 불일치.** architecture.assess는 runtime_database와 소스 DB 감지 결과의 일치 여부를 확인하지 않는다. 동일한 HTTP/5 RPS/best_effort/steady 입력에서 아래 결과를 재현했다.

| 선택 | 감지된 DB | 현재 결과 |
| --- | --- | --- |
| none | 없음 | small/medium/large 허용 |
| none | postgresql | 모두 허용: 필요한 DB 없이 배포할 위험 |
| postgres | mysql | 모두 허용: 자동 DB 변환으로 오인할 위험 |
| external | mongodb | RDS 관계형 DB 기준으로 차단: 기존 외부 DB 경로의 오차단 |

소스 감지는 확정 사실이 아닐 수 있으므로 충돌을 별도 검토 상태로 표시하고 해소 전 자동 실행을 막아야 한다. external은 관리형 RDS 호환성 판단에서 분리한다. SQLite/로컬 파일 영속성은 external 선택만으로 해결되었다고 처리하지 않는다.

3. **외부 Secret 읽기 권한 누락.** AWS config.secrets는 임의 등록 ARN을 허용하고 ECS secrets.valueFrom으로 전달한다. foundation.yaml의 ExecutionRole은 생성된 DbSecret에 대해서만 secretsmanager:GetSecretValue를 부여한다. CreateDatabase=false이면 해당 허용도 없다. 기본 스택만으로는 외부 DB URL Secret을 읽을 수 없다. 필요한 ARN에 한정된 실행 역할 권한 및 고객 관리 KMS 키 사용 시 복호화 권한을 준비해야 한다. 실제 AccessDenied를 일으키는 클라우드 실험은 수행하지 않았다.

4. **언어 지원과 배포 지원은 다름.** Tree-sitter 언어 지원이 자동 Dockerfile 생성/DB 탐지를 늘리지는 않는다. Go/Rust는 현재 유효한 기존 Dockerfile과 명시적 HTTP runtime, HTTP workload 선택이 필요할 수 있다. 소스만 보고 DB가 없다고 확정하면 안 된다. C/C++/C#/Ruby/PHP는 보안 규칙 미지원 REVIEW를 유지한다.

## 구현 방향

- 재사용: Tree-sitter/Semgrep 공개 규칙, Node WHATWG URL API, AWS SDK/Secrets Manager/ECS의 secret 주입.
- 직접 구현: DB 모드/감지 결과 충돌 정책, postgres_url 바인딩과 어댑터 연결, Secret 수명/권한/암호 회전 정책. 자체 DB 드라이버/암호화/URL 파서는 만들지 않는다.
- 검증: none/postgres/external × 로컬/AWS, 특수문자 비밀번호, 비밀값 로그 차단, IAM 미설정, DB 유형 충돌, 초기화 실패, 암호 회전.

## 후속 수정 (2026-10-10)

1~3은 #12에서 코드 수정했다. `postgres_url` 바인딩을 양쪽 어댑터에 추가하고,
AWS는 전용 URL Secret 갱신 및 버전 고정 참조를 사용한다. none/감지 DB 및
postgres/다른 DB 충돌은 계획·실제 빌드에서 차단한다. external MongoDB는
관리형 RDS 검사에서 분리했다. 외부 Secret/KMS 권한은 정확한 ARN을 받는
조건부 스택 파라미터로 추가했다. 기존 스택 업데이트와 설정 재생성이 필요하다.

엔진 275, 로컬 10, AWS SDK 33 테스트 통과. 템플릿 lint와 웹 lint/build 통과.
실제 AWS IAM/외부 DB 연결 및 새 URL Secret 경로는 이번에 실측하지 않았다.
4번 언어별 자동 이미지 생성/탐지 제한은 여전히 남아 있다.

실제 로컬 컨테이너 5조합(Node/Python DB 없음·PG 및 Node DATABASE_URL) HTTP 200,
초기화 2회, 특수문자·Unicode 비밀번호 연결을 확인했다. 임시 리소스 정리 완료.
증거: [로컬 실행 결과](evidence/2026-10-10-postgres-url-runtime.json).
