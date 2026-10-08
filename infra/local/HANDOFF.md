# 김태윤 담당: 로컬 배포 + 샘플 게시판

상태: **담당 영역 구현 및 단독 검증 완료, 팀 통합 검증 대기** (2026-10-08).

## 변경 범위

| 경로 | 제공 기능 |
| --- | --- |
| `infra/local` | PostgreSQL·앱·Cloudflare Tunnel 실행, 배포 Target API, 로그·정리, 자동 리허설 |
| `samples/kty-board` | 기존 게시판의 PostgreSQL 전환, Docker 이미지, DB health, 데이터 유실 데모 프로필 |

통합된 공통 계약은 [`target.yaml`](../../packages/contracts/openapi/target.yaml) v0.1.1을
따른다. AWS PR과 통합하며 공용 게시판, PostgreSQL JDBC 세션 초기화, AWS PostgreSQL 설정을 함께 맞췄다.

## 가장 빠른 확인 방법

저장소 루트에서 Docker를 실행한 상태로:

```sh
npm run demo --prefix infra/local
```

Node.js 22+, Python 3, Docker Compose v2 및 이미지/Gradle 다운로드를 위한 네트워크가
필요하다. 별도 DB 비밀번호를 입력하지 않아도 테스트용 비밀번호를 자동 생성한다.

1. 현재 게시판 Docker 이미지 빌드.
2. 정상 PostgreSQL 모드에서 회원가입·로그인·글 작성.
3. 앱 재시작 후 글 유지 확인.
4. `demo-reset` 프로필로 전환하고 글 작성.
5. 앱 재시작 후 글 유실 확인.
6. 정상 모드로 전환하고 새 글 작성.
7. 재시작 후 새 글 유지 확인.

실행마다 별도 DB 볼륨과 빈 로컬 포트를 사용한다. 검사 성공/실패 후 해당 실행의
컨테이너·네트워크·볼륨만 정리하고 `.data/rehearsal-*/report.json`에 결과를 남긴다.
이미 실행 중인 다른 게시판이나 배포에는 영향을 주지 않는다.

## 도경님: 엔진 연결

실행 상세는 [README](README.md#engine-integration), 요청 본문은
[`deploy.example.json`](deploy.example.json)을 참고한다.

```sh
# 저장소 루트
# 실제 통합에서는 엔진이 빌드·공유한 이미지 주소를 사용한다.
docker build -t shakedown/kty-board:local samples/kty-board
cd infra/local
cp .env.example .env
# .env의 LOCAL_DB_PASSWORD를 임의의 강한 비밀번호로 변경
npm start
```

별도 터미널에서 `infra/local`을 작업 디렉터리로 사용:

```sh
curl -f http://127.0.0.1:9101/health
curl -sS -H 'Content-Type: application/json' --data-binary @deploy.example.json \
  http://127.0.0.1:9101/deployments
curl -sS http://127.0.0.1:9101/deployments/dep_localdemo
```

- `POST /deployments`에 이미지·포트·health 경로·배포 ID를 전달한다. `202` 이후
  `GET /deployments/{deployment_id}`를 2~3초 간격으로 폴링한다.
- `database.engine`은 `postgres`, 게시판 `health_path`는 `/health`를 사용한다.
- `pending → deploying → ready/failed`. `ready`일 때 `url`을 시운전 모듈에 전달한다.
- `ready`는 **공개 URL + health_path의 HTTP 200**을 확인한 상태다. 리디렉션은
  성공으로 취급하지 않는다. 컨테이너 실행만으로 성공을 반환하지 않는다.
- 동일 배포 ID·본문은 기존 결과를 반환한다. 변경된 본문 또는 삭제된 ID는 409를 반환한다. 진행 중인 프로젝트에 다른 배포 ID로
  요청하면 `409`. 새 배포 ID는 별도 DB 볼륨을 사용한다.
- `secret_refs.SPRING_DATASOURCE_PASSWORD=db_password`는 로컬 `.env`의
  `LOCAL_DB_PASSWORD`로 해석된다. 다른 비밀값은 `LOCAL_SECRETS_FILE` JSON에 정의한다.
- DB 주소·사용자·비밀번호는 로컬의 실제 PostgreSQL과 일치하도록 설정된다.
- `GET /deployments/{id}/logs`는 `ts/source/line` 목록을 제공한다. `since` 필터 지원.
- `DELETE /deployments/{id}`는 배포 컨테이너와 네트워크를 제거하고 DB 볼륨·로그는 보존한다. 삭제된 ID 조회는 404, 반복 삭제는 204이다.

응답 예시(실제 URL·시각은 실행별로 다름):

```json
{
  "deployment_id": "dep_localdemo",
  "target": "local",
  "status": "ready",
  "url": "https://example.trycloudflare.com",
  "instances": 1,
  "info": {
    "runtime": "Docker Compose",
    "database": "PostgreSQL 17",
    "timezone": "Asia/Seoul",
    "sticky_sessions": "false",
    "replicas": "1"
  }
}
```

API는 `127.0.0.1:9101`에만 바인딩한다. 엔진을 같은 PC에서 실행하거나 SSH 포트
포워딩으로 연결한다. Cloudflare에는 **게시판 포트만** 공개하며 제어 API는 공개하지 않는다.

## 태현님: 시운전 연결

- `GET /health`: DB 연결까지 정상이어야 200.
- `POST /join`: 폼 필드 `email`, `nickname`, `password`.
- `POST /login`: 폼 필드 `email`, `password`. 이후 `SESSION` 쿠키 유지.
- `POST /api/posts/write`: 폼 필드 `title`, `content`, 로그인 쿠키 필요.
- `GET /api/posts`: JSON 목록. 작성한 고유 제목이 실제 목록에 있는지 확인.
- `GET /api/posts/{id}`: JSON 상세.

폼 요청은 리디렉션되므로 최종 HTTP 200만으로 로그인/작성 성공을 판정하면 안 된다.
[smoke.py](smoke.py)에 실제 가입 → 로그인 → 작성 → 목록·상세 확인 예제가 있다.

데모는 **PostgreSQL을 사용하는 상태에서 앱 재시작**으로 데이터 유실을 재현한다.
`demo-reset` 프로필은 `ddl-auto=create`, 정상 모드는 `update`이다. 수정은 이후 데이터
유실을 막는 것이며 이미 삭제된 글을 복구하지 않는다. 별도 일회용 DB에서만 실행한다.
재시작은 로컬 리허설 스크립트가 수행하며, 공통 Target API에 재시작 엔드포인트를 추가하지 않았다.
따라서 URL만 받는 시운전 모듈과 자동 재시작/수정 흐름 연결은 통합 작업으로 남아 있다.

## 재환님: AWS의 동일 앱 실행

- 게시판 JDBC 드라이버는 **PostgreSQL**이다. RDS PostgreSQL 주소와
  `SPRING_DATASOURCE_URL/USERNAME/PASSWORD`를 설정한다.
- MySQL JDBC 주소를 그대로 사용하면 실행되지 않는다.
- Local/AWS 비교에는 같은 코드·이미지를 사용한다. 이 Mac에서 빌드한 ARM 이미지의
  로컬 태그는 검증용이며, 실제 공유 이미지의 레지스트리 접근·대상 아키텍처는 별도 확인해야 한다.
- 데이터 유실 데모를 AWS에서도 사용하려면 일회용 DB에서 같은 프로필·재시작 조건을 적용한다.
  단순히 RDS를 연결하는 것만으로 `ddl-auto=create`가 해제되지는 않는다.

## 검증 결과와 남은 범위

2026-10-08 PR #2/#4 통합본에서 Node 테스트 7개, 정상/버그/수정 리허설 7단계를 재검증했다. PostgreSQL JDBC 세션도 앱 2개 간 10회 교차 요청 및 재시작 후 보존을 확인했다. 수정한 Target API로 JDBC 모드 배포→외부 HTTPS 가입/로그인/글 작성까지 통과했으며, 삭제 후 로그 보존·404·재사용 409도 확인했다.

| 확인 | 결과 |
| --- | --- |
| Gradle test + bootJar | Java 테스트 3개 통과, 빌드 성공 |
| Node Target API 테스트 | 7개 통과 |
| 실제 PostgreSQL HTTP 흐름 | 가입·로그인·작성·목록·상세 통과 |
| 정상/버그/수정 자동 리허설 | 7단계 통과, 테스트 자원 정리 성공 |
| 실제 Target API | POST → 상태 조회 → 공개 URL ready, 로그, DELETE 후 재배포 확인 |
| 공개 HTTPS 게시판 smoke | 통과; 이 Mac의 DNS 캐시 때문에 명시적 DNS 해석 사용, TLS 검증 유지 |

남은 팀 통합 검증:

- [ ] 도경님 실제 엔진에서 이 API 호출.
- [ ] 공통 레지스트리 이미지로 Local/AWS 배포.
- [ ] 태현님 검사 결과를 엔진을 거쳐 대시보드에 표시.
- [ ] 두 환경에서 재시작·유실·수정 시나리오 전체 리허설.

현재 제약: 로컬은 앱 1개 인스턴스만 실행하며 replicas/sticky_sessions 요청은 실제
값(1/false)으로 보고한다. `ready`는 마지막 배포 검증 결과이며 지속 모니터링은 아니다.
서비스 재시작 중 미완료 배포는 failed로 복구한다. Quick Tunnel 주소는 재생성 시 바뀐다.

## AWS PR 통합 후

공용 게시판은 PostgreSQL과 `SESSION` 쿠키를 사용한다. Local Target API도 배포 전에
`schema-init`을 실행하므로 `demo,session-jdbc` 프로필을 받을 수 있다. 앱 재시작 시
데이터 유실(`demo-reset`)과 두 서버 간 세션 유실(`session-memory`)은 서로 다른
데모이며, 후자는 `session-jdbc`로 수정한다.
AWS 어댑터는 ECS/ALB + RDS PostgreSQL로 맞췄으며 실제 클라우드 배포 검증은 남아 있다.
