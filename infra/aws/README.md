# AWS 배포 모듈 — ECS Fargate + ALB + RDS

김재환 담당 범위의 구현입니다. 한 프로젝트에 대한 AWS 배포·준비 상태 확인·로그 조회·공개 접근 차단을 제공합니다. App Runner 대신 ECS Fargate를 사용합니다. **실제 AWS 계정은 아직 정해지지 않았고, 클라우드 배포는 검증 전입니다.** API/SDK 경계 테스트와 실제 로컬 컨테이너 검증은 구분해서 기록합니다.

## 구성과 실행 순서

```mermaid
flowchart LR
  Engine[Python 배포 엔진] -->|HTTP 9102, loopback| Adapter[AWS 어댑터]
  Adapter --> State[(로컬 SQLite 실행 기록)]
  Adapter --> ECS[ECS Fargate 1~2개]
  Adapter --> ALB[ALB HTTP 80]
  ALB --> ECS
  ECS --> DB[(비공개 RDS PostgreSQL)]
  ECS --> Logs[CloudWatch 7일]
  Secret[Secrets Manager] -->|ECS execution role| ECS
```

- 리전: 서울. Linux AMD64, 0.5 vCPU/1 GiB, 고정 replicas 1~2. 한 스택·어댑터 프로세스·상태 DB를 한 프로젝트에 연결합니다.
- 공개 ALB → 앱 SG 8080 → DB SG 5432. RDS는 인터넷 경로 없는 서브넷에 배치합니다.
- 앱은 public subnet/public IP로 ECR·로그에 접근합니다. 인터넷에서 앱 포트 직접 접근은 SG가 막습니다. NAT Gateway는 만들지 않습니다.
- 초기 스택 생성 및 DB 초기화는 배포 버튼과 분리합니다. 매 배포는 기존 ECS 서비스의 task definition만 교체합니다.
- 실제 API는 `packages/contracts/openapi/target.yaml`. 엔진은 로컬 배포까지 연결되어 있으며 AWS 호출·ECR 업로드·시운전은 아직 미연결입니다. **팀 전체 연결 완료는 아닙니다.**

## AWS 없이 검증

저장소 루트, Node 24:

```sh
npm ci --ignore-scripts
npm run check:aws
npm run test:aws
```

실제 세션 문제 재현에는 Docker가 필요합니다. 아래 테스트는 독립 PostgreSQL DB와 임시 컨테이너만 생성하고 종료 시 해당 자원만 삭제합니다. 기존 서비스/볼륨은 건드리지 않습니다.

```sh
docker build --platform linux/amd64 -t shakedown-board:aws-session-test samples/kty-board
python3 infra/aws/scripts/session-smoke.py
```

검증: 스키마 초기화 재실행, 서버 A 로그인→B 실패(memory), A 로그인→B 성공(jdbc), B에서 글 작성→A/B에서 조회, 앱 재시작 후 세션·게시글 보존. 결과는 `.data/session-smoke/latest.json`에 남깁니다. 이 결과는 AWS ALB/RDS 검증을 대신하지 않습니다.

## 계정이 정해진 뒤 실행할 절차

아래 단계는 비용이 발생하는 실제 AWS 작업입니다. 아직 실행하지 않았습니다. 기존 `default` 프로필을 자동으로 사용하지 않습니다.

1. 해커톤 전용 named profile과 12자리 계정 ID를 선택합니다. 프로비저닝 권한, 어댑터 역할, 이미지 업로드 역할을 구분합니다. 비밀키를 Git/Notion에 적지 않습니다.
2. 프로비저닝 담당 권한으로 CloudFormation을 실행합니다. RDS minor 버전과 db.t3.micro의 서울 리전 가용성을 먼저 조회합니다. 사용할 PostgreSQL 17 minor 버전을 `HACKATHON_POSTGRES_VERSION`에 반드시 지정하세요. 지원 여부는 스크립트가 계정·리전에서 확인합니다.

```sh
export HACKATHON_PROVISION_PROFILE=hackathon-provision
export HACKATHON_ACCOUNT_ID=YOUR_ACCOUNT_ID
export HACKATHON_STACK=shakedown-board
bash infra/aws/scripts/provision.sh
mkdir -p .data/aws
aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 cloudformation describe-stacks \
  --stack-name "$HACKATHON_STACK" --query 'Stacks[0].Outputs' --output json > .data/aws/outputs.json
node --import tsx infra/aws/scripts/config-from-outputs.ts .data/aws/outputs.json \
  hackathon-adapter "$HACKATHON_ACCOUNT_ID" prj_board > .data/aws/config.json
```

3. Outputs의 `AdapterPolicyArn`을 어댑터가 사용할 principal에, `ImagePublisherPolicyArn`을 엔진/이미지 빌드 principal에 부여합니다. 어댑터에는 DB 비밀값 조회 권한이 없습니다. `PassRole`은 이 스택의 실행·앱 역할만 허용합니다. 실행 역할만 ECR pull/로그/해당 DB secret을 사용할 수 있고 앱 task role에는 AWS 관리 권한이 없습니다. ECS 서비스 연결 역할은 첫 사용 때 생성할 수 있도록 범위를 제한했습니다.
4. 엔진이 이미지를 **한 번** 빌드·업로드하고 반환된 digest 주소를 Local/AWS 모두 사용합니다. 수동 준비용 보조 스크립트는 아래와 같습니다. multiarch/index manifest 대신 단일 AMD64 manifest를 사용합니다.

```sh
export HACKATHON_PUBLISH_PROFILE=hackathon-publisher
export HACKATHON_REPOSITORY=shakedown-board
export HACKATHON_IMAGE_TAG=UNIQUE_COMMIT_TAG
bash infra/aws/scripts/publish-image.sh
```

5. 같은 digest 이미지로 스키마 초기화 작업을 한 번 실행합니다. AWS에서는 schema-init으로 JPA DDL update와 버전에 맞는 Spring Session PostgreSQL SQL을 수행합니다. AWS 앱 서비스는 주입된 DDL validate 설정으로 실행되므로 여러 서버가 테이블을 동시에 만들지 않습니다. schema-init은 테이블을 비우지 않지만, 운영 마이그레이션 도구는 아닙니다. 실행 중인 앱이 없는 초기 준비 시점에 실행합니다.

```sh
npm run bootstrap -w @shakedown/aws -- ../../.data/aws/config.json 'ECR_URI@sha256:DIGEST'
```

6. 어댑터를 실행합니다. `AWS_ADAPTER_CONFIG`는 절대 경로 권장입니다. config는 계정/ARN을 포함하지만 비밀값은 포함하지 않습니다.

```sh
export AWS_ADAPTER_CONFIG="$PWD/.data/aws/config.json"
export AWS_ADAPTER_DB="$PWD/.data/aws/state.sqlite3"
npm run dev:aws
```

서버는 `127.0.0.1:9102`만 바인딩합니다. 프로세스 시작 시 STS 계정 검증과 중단된 배포 복구를 마친 후 포트를 엽니다. `.lock`이 남았으면 기록된 PID가 종료됐는지 확인한 후에만 삭제합니다. 동일 스택을 다른 DB/프로세스로 동시에 제어하지 않습니다.

## 엔진 연결 예시와 계약

`POST /deployments` → 202 → 2~3초마다 GET → `ready` 후 공개 URL로 시운전합니다.

```json
{
  "deployment_id": "dep_demo01",
  "project_id": "prj_board",
  "image": "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/shakedown-board@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "port": 8080,
  "health_path": "/",
  "env": { "SPRING_PROFILES_ACTIVE": "demo,session-memory" },
  "secret_refs": { "SPRING_DATASOURCE_PASSWORD": "db_password" },
  "database": { "engine": "postgres", "name": "board_db" },
  "options": { "replicas": 2, "sticky_sessions": false, "tz": "UTC" }
}
```

- DB URL/사용자/비밀번호는 스택 설정에서 ECS에 주입합니다. `secret_refs`는 `SPRING_DATASOURCE_PASSWORD: db_password`만 지원하며 생략해도 같은 관리형 설정을 사용합니다. 임의 env, plaintext secret, 다른 DB, sticky=true, replicas>2는 400입니다.
- 동일 ID+내용 재시도는 기존 결과, 다른 내용/삭제 ID/프로젝트 동시 변경은 409입니다. 새 배포에는 새 ID를 사용합니다.
- `ready`: 현재 revision과 digest가 일치하는 앱 task 수 확인 → 이전 task/target 제거 → ALB targets 모두 healthy → 공개 라우트 연결 → **쿠키 없이 health_path HTTP 200**. 리다이렉트는 성공으로 보지 않습니다.
- 준비 대기는 270초 제한. 실패 시 공개 차단과 앱 정리를 시도합니다. 정리 자체는 최대 120초 추가될 수 있으므로 엔진은 5분 타임아웃 뒤에도 로그 조회 및 DELETE를 수행해야 합니다. 정리 실패 시 새 배포를 잠그고 DELETE 재시도를 받습니다.
- `info`: runtime, session, timezone, sticky_sessions, task_definition, image_digest. task 수/digest는 ECS task에서, 세션/TZ는 등록된 task definition에서 읽습니다. DB 엔진 표기는 이 스택의 설정 정보입니다.
- GET 로그는 timestamp/source/line 배열. 앱 로그는 배포 ID별 CloudWatch stream들의 최근 50개를 합칩니다. 배포 로그와 합쳐 최대 200개. `since`는 ISO 8601이며 비밀 필드를 가립니다. SDK 호출을 사용하므로 실행하지 않은 CLI 명령을 `commands`에 넣지 않습니다.

### BLOCKED 판정과 실제 차단

엔진은 판정 후 **증거 및 최근 로그 수집 → DELETE → 차단 확인 → AI 보고서** 순서로 연결합니다. AI 보고서 실패가 공개 라우트를 다시 열면 안 됩니다.

- 최신 배포 DELETE: ALB 고정 403 설정 및 HTTP 403 확인 → ECS 서비스 desired=0/삭제 → 중지 확인 후 204.
- 이전 배포 DELETE: 과거 기록만 삭제 표시, 현재 서비스는 유지.
- 삭제된 GET은 404, 동일 ID 재사용은 409. 로그는 계속 조회할 수 있습니다. RDS/CloudWatch는 남습니다.
- 삭제 도중 오류는 502이며 DELETE를 재시도할 수 있습니다. 실패했는데 204를 보내지 않습니다.
- 새 배포 준비 중에는 403을 유지합니다. 정상 운영 버전을 따로 유지하는 Blue/Green/자동 롤백은 이번 구현 범위에 없습니다.
- 과거 GET 결과는 해당 배포 완료 당시의 기록입니다. URL이 지금도 그 버전을 제공한다는 의미는 아닙니다. 엔진은 최신 배포 ID를 표시해야 합니다.

## 시연과 남은 통합

1. 동일 image digest + PostgreSQL로 Local 1대 / AWS 2대를 시작합니다. AWS profile은 `demo,session-memory`, stickiness=false.
2. 시운전이 로그인→글쓰기의 `302 /` 차이와 `X-Instance-Id` 변경을 수집해야 합니다. ALB round-robin이 항상 A/B 교대를 보장하지 않으므로 인스턴스가 실제 바뀌었는지 증거로 확인합니다. 전환이 없으면 재시도/미검증 처리하며 통과로 꾸미지 않습니다.
3. 문제는 DB가 글을 삭제한 것이 아니라 **서버 간 로그인 세션이 공유되지 않아 글 저장 전에 로그인 화면으로 돌아간 상황**입니다. 실제 저장된 글의 영속성 검증은 별도 단계입니다.
4. BLOCKED 후 로그 수집/DELETE 403 확인. 새 ID와 `demo,session-jdbc`로 같은 이미지를 배포한 뒤 다시 검사합니다.
5. 앱 재배포 후 DB 글과 로그인 세션 유지, CLI/API 이벤트 시간, 공개 URL, 실제 task/target 수를 기록합니다.

엔진 담당자와 연결할 항목: ECR push/digest 고정, 위 POST/GET/DELETE 호출, Local에도 같은 digest와 JVM/DB 호환 설정 전달, BLOCKED 시 로그→DELETE 순서. 샘플 담당자와 연결할 항목: Dockerfile/프로필/헤더 및 schema-init. Local과 AWS 모두 PostgreSQL을 사용하며 schema-init은 PostgreSQL 세션 테이블을 초기화합니다. Local 배포 API도 초기화 작업을 수행합니다.

## 비용·정리·제한

ALB, Fargate, public IPv4, RDS, ECR, Secrets Manager, 로그 비용이 발생합니다. DELETE는 앱만 내려가며 ALB/RDS 비용은 계속됩니다. 데모 종료 후 인프라 담당자가 별도 스택 정리를 수행해야 합니다. DB는 스택 삭제 시 snapshot, ECR/로그/secret은 Retain이므로 남은 리소스와 snapshot 비용도 확인합니다. 앱을 먼저 DELETE해야 동적으로 만든 ECS 서비스가 스택 정리를 막지 않습니다.

HTTP 데모라 실제 사용자 개인정보/비밀번호는 사용하지 않습니다. 샘플의 기존 단순 인증 구조는 운영 서비스용으로 강화한 범위가 아닙니다. 이번 스키마 초기화는 같은 DB 계정을 사용하며, 운영 전환 시 애플리케이션 DML 계정과 마이그레이션 DDL 계정을 분리해야 합니다. 정식 서비스의 HTTPS/인증/역할별 DB 권한/버전 마이그레이션은 별도입니다.

참고: [ECS Fargate 네트워크](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html), [Spring Session JDBC](https://docs.spring.io/spring-session/reference/configuration/jdbc.html), [RDS PostgreSQL 버전](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.VersionMgmt.html).

## 검증 기록 — 2026-10-08

- TypeScript strict 검사와 공통 계약 타입 검사 통과.
- 어댑터/API/SQLite 및 AWS SDK 경계 테스트 **15개 통과**. SDK 응답은 테스트 대역이며 실제 AWS 배포 성공을 의미하지 않습니다.
- 샘플 Gradle 테스트 **3개 통과**, bootJar 및 Linux AMD64 Docker 이미지 빌드 통과.
- 실제 PostgreSQL 17 + ARM64 앱 컨테이너 2개: memory 모드의 교차 서버 로그인 실패 재현, JDBC 모드 **10회 교차 요청 통과**, 글 작성/양쪽 조회 및 앱 재시작 후 세션·게시글 보존 확인. [실행 결과](test/evidence/session-smoke-postgres-2026-10-08.json).
- CloudFormation `cfn-lint` 서울 리전 검사 통과. OpenAPI lint 오류 0개, 기존 형식 관련 경고 5개(license, localhost 서버 주소 2건, health/logs의 4xx 응답 표기 2건).
- 실제 AWS 자원 생성/배포, IAM 권한 실증, ALB 라우팅/403, RDS TLS 및 팀 엔진의 원클릭 연결은 **아직 미검증**.
