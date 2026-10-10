# Azure 배포 모듈: Container Apps + PostgreSQL (작업 명세)

> **상태: 작업 명세 v0.3 (2026-10-09)**. 담당: 서동옥. 아직 구현 전입니다.
> 규칙은 `packages/contracts/openapi/target.yaml`과 AWS 어댑터(`infra/aws`)를 그대로 따르고, 이 문서에는 **Azure에서 다른 점만** 적습니다.
> 실측이 필요한 가정과 팀 결정 사항은 마지막 "열린 항목" 한 곳에서 관리합니다.

## 1. 목표와 범위
- Action 한 번에 Local, AWS와 함께 **Azure에도 같은 이미지(같은 digest)**를 배포하고, **https 공개 주소**를 엔진에 돌려준다.
- 시연 앱(kty-board) 1개용 전용 인프라를 미리 만들어 두고, 배포 때는 앱 이미지와 설정만 바꾼다. (AWS와 같은 방식)
- 범위 밖: 배포 버튼으로 인프라 생성, 여러 프로젝트, 카나리, Blue/Green

## 2. 구성

```mermaid
flowchart LR
  Engine[엔진] -->|HTTP, 127.0.0.1:9104| Adapter[Azure 어댑터 Node/TS]
  Adapter --> State[(로컬 SQLite 실행 기록)]
  Adapter -->|Azure SDK + az login 자격| ACA[Container App 복제본 1~2개]
  Internet((인터넷)) -->|HTTPS 기본 주소| ACA
  ACA -->|가상 네트워크 내부| DB[(PostgreSQL Flexible 17)]
  ACA -->|관리 ID| KV[Key Vault: DB 비밀번호]
  ACA -->|관리 ID| ACR[Container Registry]
  ACA --> Logs[Log Analytics]
```

| 역할 | Azure 리소스 | AWS 대응 |
|---|---|---|
| 앱 실행 | Container Apps (워크로드 프로필 환경의 Consumption 프로필, 단일 리비전 모드), linux/amd64 | ECS Fargate |
| 공개 주소 | 기본 ingress `*.azurecontainerapps.io`, 관리 인증서로 **HTTPS만** (http 거부) | ALB HTTP 80 |
| DB | PostgreSQL Flexible Server 17, Burstable B1ms, 공개 접근 끔 (Korea Central 지원 확인됨) | RDS PostgreSQL 17 |
| 비밀값 | Key Vault(RBAC) + 사용자 할당 관리 ID. 앱만 읽고 **어댑터는 비밀번호를 읽을 권한이 없음** | Secrets Manager + 실행 역할 |
| 이미지 저장소 | ACR Basic, 관리자 계정 끔, 관리 ID로만 pull | ECR |
| 로그 | Log Analytics (보관 30일: 최소값, 추가 비용 없음) | CloudWatch 7일 |
| 네트워크 | 가상 네트워크 1개: 앱 서브넷(`Microsoft.App/environments` 위임) + DB 서브넷(`Microsoft.DBforPostgreSQL/flexibleServers` 위임) + 비공개 DNS 영역 | VPC, 보안 그룹 |
| 인프라 정의 | Bicep | CloudFormation |

- 리전 Korea Central, 리소스 그룹 1개(`rg-shakedown-board`)에 전부 넣어 데모 후 한 번에 삭제한다.
- 가상 네트워크 구성이 Day1에 막히면 **대안**: DB 공개 접근 + "Azure 서비스 허용" 방화벽 + `sslmode=require`. 다른 Azure 고객도 접근 경로가 생기므로 대안으로만 쓴다.

## 3. AWS와 다른 점 (Target API)
입력 검증(`infra/aws/src/config.ts` `validateRequest`), 409·멱등·재시작 복구(`manager.ts`), loopback·Origin·Host 거절과 본문 32KB 제한(`app.ts`)은 **AWS와 동일**하다. 다른 점은 아래뿐이다.

| 항목 | Azure |
|---|---|
| `image` | 설정한 ACR 저장소의 `@sha256:` digest만 허용. 배포 전에 ACR에 그 digest가 있는지 확인, 없으면 400 |
| `options.sticky_sessions` | ingress 세션 고정으로 **지원 가능** (AWS는 false만). 실제로 열지는 팀 데모 규칙으로 결정 |
| 배포 | Container App **한 번의 갱신**으로 이미지·환경변수·복제본(최소=최대)·TZ·health 확인 경로·ingress 켜기를 같이 반영. 세션 고정만 바뀌면 앱 수준 변경이라 새 리비전을 만들지 않음 |
| `ready` | 새 리비전이 Healthy이고 트래픽 100% → **쿠키 없이 https health_path 200** (리다이렉트는 실패). AWS와 같은 기준 |
| 시간 제한 | AWS와 같게 준비 270초, 실패 시 정리 최대 120초 |
| DELETE | 한 번의 갱신으로 ingress 끄기 + 활성 리비전 비활성화 → 공개 주소가 앱 응답을 주지 않음을 확인 → 204. 오류는 502(재시도 가능), 이미 삭제된 ID는 204. DB·로그 보존 |
| 로그 | 최근 로그는 Container Apps 로그 스트림(거의 실시간), 이전 로그는 Log Analytics 한 번 조회 (반영이 수 분 늦음) |
| `info` | AWS와 같은 키: `runtime: Azure Container Apps`, `database`(실제 서버에서 읽은 엔진·버전, 예: `Azure PostgreSQL Flexible 17`, DB를 안 쓰면 `none`), `session`, `timezone`, `sticky_sessions`, `image_digest`, `revision`, `transport: HTTPS` |
| `commands` | AWS와 같게 비움 (SDK로 호출하므로 실행하지 않은 CLI 명령을 적지 않음) |
| `runtime` (범용 HTTP 런타임) | 엔진이 `project.runtime`을 보내면 `database`·`secret_refs` 대신 사용. AWS와 같은 모드를 모두 받는다 (13절): 관리 DB `postgres`·`mysql`·`mongodb`는 스택의 엔진과 같아야 하고, `external`·`none`은 어느 스택에서나 된다. 비밀은 전부 Key Vault 참조 |

어댑터 시작 시 한 번: 구독·테넌트가 설정과 같은지 확인(다르면 실행 거부, 회사 계정 보호), SDK 클라이언트 생성, PostgreSQL 서버가 중지 상태가 아닌지 확인.

## 4. 엔진·계약에 필요한 변경 (Azure 밖 작업, 김도경 님과 협의)
지금 엔진은 대상이 `local`, `aws`로 고정되어 있어 Azure를 끼우려면 엔진 수정이 필요하다 (`apps/engine/engine/deployments.py`).
- **대상 표 하나로 일반화**: 이름 → 어댑터 주소, 허용 옵션, 시간 제한, 이미지 저장소. 대상 목록 2개 제한, `aws` 하드코딩, 비교 대상 `Endpoint(name='aws')`를 이 표 기준으로 변경
- **이미지 게시 일반화**: 한 번 빌드한 digest를 선택된 대상마다 그 대상의 저장소로 `crane copy` (내용을 그대로 복사해 digest 유지). `docker push`를 두 번 하는 방식은 digest가 달라질 수 있어 쓰지 않음. 복사는 Local·AWS 배포와 동시에 진행. ECR→ACR 고정이 아니므로 Local+Azure만으로도 동작
- **계약 문서**: `target.yaml` 서버 목록에 9104 추가, 대상별 제약은 산문 대신 `packages/contracts/README.md`에 표 하나로 정리
- 대시보드: `apps/web/src/lib/targets.ts`에서 azure `available: true`

## 5. 설정 파일 (`.data/azure/config.json`, 비밀값 없음)
AWS `configSchema`와 같은 이름을 쓴다. Bicep 출력값에서 `config-from-outputs.ts`와 같은 방식으로 만든다.
```json
{
  "subscriptionId": "...", "tenantId": "...", "resourceGroup": "rg-shakedown-board",
  "projectId": "prj_board", "containerApp": "sd-app",
  "repositoryUri": "sdacr<접미사>.azurecr.io/shakedown-board",
  "publicUrl": "https://sd-app.<환경>.koreacentral.azurecontainerapps.io",
  "dbHost": "<서버>.postgres.database.azure.com", "dbName": "board_db", "dbUsername": "app",
  "dbPasswordSecretUri": "https://<볼트>.vault.azure.net/secrets/db-password",
  "port": 8080
}
```

## 6. 파일 구성
AWS 어댑터와 같은 구조에 `bicep/`(main: 기반, app: 앱과 스키마 초기화 작업), `src/azure-provider.ts`, `scripts/`(provision, publish-image, schema-init, session-check)를 추가한다. 각 파일 첫머리 주석에 역할과 이유를 적었다. `store.ts`, `manager.ts`와 `model.ts`의 Provider 인터페이스는 `target` 이름 외에 AWS 전용 내용이 없어서 공용으로 빼서 같이 쓴다 (김재환 님 합의 후. 합의 전이면 복사 후 나중에 합침).

## 7. 처음 한 번 준비 (비용 발생)
해커톤 구독은 무료 체험(지출 한도 켜짐)이라 크레딧을 넘겨 청구되지 않는다. 그래서 예산 알림은 생략한다.

```sh
export AZURE_SUBSCRIPTION_ID=<해커톤 구독 ID>
bash infra/azure/scripts/provision.sh what-if          # 서비스 등록 + 빈 리소스 그룹 + 바뀔 내용 확인
bash infra/azure/scripts/provision.sh                  # 기반(main.bicep) → 90초 대기 → 앱(app.bicep) → .data/azure/config.json
IMAGE=$(bash infra/azure/scripts/publish-image.sh)     # linux/amd64 단일 manifest로 ACR에 올리고 digest 주소 출력
bash infra/azure/scripts/schema-init.sh "$IMAGE"       # 스키마 초기화 작업 1회
npm run dev:azure                                      # Node 24 필요 (node:sqlite)
```

- 다시 돌려도 이미 만든 단계는 건너뛴다 (DB 비밀번호와 어댑터가 배포한 앱 유지)
- 정리: `az group delete -n rg-shakedown-board` 후 Key Vault 이름이 7일간 예약되므로 다시 만들 때는 `az keyvault purge -n <볼트>`

## 8. 테스트
- Azure 없이: `infra/aws/test/adapter.test.ts`의 항목을 가짜 Provider로 그대로 실행
- Azure에서: `scripts/session-check.py <공개 URL>`로 로그인 후 요청 20번의 로그인 유지 여부를 확인. 2026-10-09 결과는 `test/evidence/session-azure-2026-10-09.json` (session-memory 19/20 풀림, 세션 고정·session-jdbc 0/20)

## 9. 작업 목록과 공수

| 순서 | 할 일 | 공수 | 완료 기준 |
|---|---|---|---|
| 1 | 공용 코드 분리 + 어댑터 서버 + 설정 검증 | 0.5일 | AWS 테스트 항목이 가짜 Azure로 통과 |
| 2 | `azure-provider.ts`: 갱신, 리비전 상태, https 확인, 로그, DELETE | 0.5 ~ 1일 | SDK 경계 테스트 통과 |
| 3 | Bicep + `provision.sh` | 0.5일 | `what-if` 오류 없음 |
| 4 | 실제 준비 (서비스 등록, 예산, 생성, 스키마 초기화) | 0.5일 | https 주소에서 게시판 접속 |
| 5 | 엔진 일반화 (4절, 김도경 님과) + 대시보드 토글 + 계약 문서 | 0.5일 | Action 한 번에 Local·AWS·Azure 배포 |
| 6 | 데모 시나리오 확인 | 반나절 미만 | 시운전이 Azure에서 차단 → 수정 후 통과 |
| **합계** | | **2.5 ~ 3일** | |

오늘 1~3 (계정 없이 가능), Day1 4~6.

## 10. 예상 비용
PostgreSQL B1ms, ACR Basic, Container Apps(무료 제공량 안쪽 예상), 로그 합쳐 수천 원 ~ 1만 원대. 가장 큰 건 PostgreSQL이라 데모 사이에 중지할 수 있지만, 다시 켜는 데 수 분 걸리므로 데모 전에 미리 켠다.

## 11. 열린 항목

| 구분 | 내용 | 담당 |
|---|---|---|
| 결정 | 엔진 일반화(4절) 범위와 일정 | 김도경 |
| 결정 | 데모 수정 방식: 세션 고정(Azure 고유) vs `session-jdbc`(공통) | 팀 |
| 결정 | 어댑터 공용 코드 분리 | 김재환 |
| 결정 | Azure 비용이 해커톤 지원금 대상인지 | 운영진 문의 |
| 결정 | 샘플 앱 `X-Instance-Id`가 Azure에서 모두 `local` (HOSTNAME 미설정). `DemoInstanceFilter`가 `CONTAINER_APP_REPLICA_NAME`도 보도록 수정 필요 | 샘플 담당 |
| 결정 | 서비스 간 토큰 헤더 (모든 어댑터가 127.0.0.1만 열어 이번엔 생략 가능) | 팀 |
| 확인됨 | 앱 서브넷 /23으로 Container Apps 환경 생성 성공 (3분 21초) | - |
| 확인됨 | 새 리비전 준비 시간: POST부터 ready까지 59초 (복제본 2, 2026-10-09) | - |
| 확인됨 | ingress를 끈 뒤 공개 주소는 404 (DELETE 완료 판정 기준) | - |
| 확인됨 | Korea Central PostgreSQL 17·B1ms 지원 (2026-10-09 `list-skus`) | - |
| 확인됨 | 최소=최대 복제본이면 리비전 상태가 `Running`이 아닌 `RunningAtMaxScale` (SDK 타입에 없음) | - |
| 확인됨 | http 접속은 https로 301 리다이렉트 | - |
| 확인됨 | 엔진 전체 흐름(Local+Azure, 2026-10-09): session-memory는 BLOCKED → 로그 수집 → DELETE 확인 → 공개 주소 404, 세션 고정은 promoted (배포~판정 약 3분) | - |
| 결정 | 클라우드와 같은 amd64 이미지를 ARM Mac Local에서 에뮬레이션으로 돌리면 Spring 시작이 느려 Local 확인 시간 제한을 넘길 때가 있음 | Local 담당 |

## 12. 아키텍처 템플릿 (작업 명세, PR #12 이후)
김태윤 님 PR #12(`codex/architecture-planner`)는 엔진이 small·medium·large 중 하나를 추천·선택하고, 배포 요청의 `architecture: {version: "aws-architecture.v1", template_id}`로 **AWS에만** 적용한다. Azure에도 같은 선택이 적용되게 세 곳을 바꾼다.

### 카탈로그 (`azure-architecture.v1`)
| | small | medium | large |
|---|---|---|---|
| CPU / 메모리 (Consumption 프로필) | 0.5 vCPU / 1 Gi | 1 vCPU / 2 Gi | 2 vCPU / 4 Gi |
| 복제본 최소~최대 | 1~1 (자동 확장 없음) | 2~4 | 3~12 |
| 자동 확장 | 없음 | HTTP 동시 요청 기준 | HTTP 동시 요청 기준 |
| 가용 영역 | 1 | 영역 중복 *(계획만)* | 영역 중복 *(계획만)* |
| DB | Burstable B1ms | General Purpose + 영역 중복 HA *(계획만)* | GP + HA + 읽기 복제본 검토 *(계획만)* |

**해커톤 범위: compute(CPU·메모리·복제본·자동 확장)만 적용.** *(계획만)* 항목은 계획서에 "운영 전환 시 필요"로 표시하고 적용하지 않는다.
- 영역 중복은 Container Apps 환경을 **만들 때만** 정할 수 있어 지금 환경(`sd-env`)을 다시 만들어야 한다.
- DB HA는 Burstable에서 지원하지 않아 GP로 올려야 하고, 월 수백 달러라 무료 크레딧(200달러)을 넘는다.

### 작업 1. Azure 어댑터 (0.5일, 우리) — **구현 완료 (2026-10-10, `src/architecture.ts`)**
- `src/architecture.ts`: 위 카탈로그 (AWS·GCP의 `architecture.ts`와 같은 모양). large 최대 6대: PostgreSQL B1ms 연결 한도 50(예약 10 제외 40) 안에 6대 × 풀 3 × 롤아웃 두 리비전이 들게 함
- `model.ts`: `architecture: {version: 'azure-architecture.v1', template_id}` 선택 필드. 있으면 `replicas`는 템플릿 최소값과 같아야 함(AWS 규칙과 동일), 없으면 지금처럼 1~2
- `azure-provider.ts desired()`: 템플릿이 있으면 CPU·메모리, `minReplicas`/`maxReplicas`, HTTP 확장 규칙을 Container App 갱신 한 번에 담음. 없으면 지금 동작(최소=최대 고정) 그대로
- 준비 판정: 자동 확장이 있으면 복제본 수를 `== replicas`가 아니라 `>= 최소`로 확인
- `info.architecture`: 템플릿 ID 또는 `legacy` (AWS와 같은 키)
- 테스트: 템플릿별 갱신 내용, 복제본 불일치 거절, 템플릿 없는 기존 요청 회귀
- 실측(2026-10-10): medium 적용 → Azure에 1 vCPU/2Gi, 복제본 2~4, HTTP 규칙 반영, 50초 만에 ready. info `scaling: automatic 2-4`, `db_availability: Disabled`, `db_tier: Standard_B1ms`

### 작업 2. 엔진 플래너 일반화 (0.5일, 서동옥)
- 지금: `'aws' not in targets`면 거절, `architecture`를 AWS에만 전달, 버전 `aws-architecture.v1` 고정, AI 과제 `choose_aws_architecture`
- 바꿀 것: **tier(small/medium/large) 선택은 클라우드 공통**, 클라우드마다 자기 카탈로그로 변환
  - 계획을 고르면 선택된 클라우드 대상 각각에 `architecture: {version: "<cloud>-architecture.v1", template_id}` 전달 (Local에는 보내지 않음)
  - `opts['replicas']`도 클라우드마다 그 카탈로그 최소값
  - 대상 표(`TARGETS`)에 `architecture` 버전을 한 칸 추가하면 aws·azure·gcp 모두 같은 코드로 처리
- 대시보드 플래너 화면: 템플릿 카드에 클라우드별 실제 값(AWS: 태스크·RDS, Azure: 복제본·PostgreSQL Flexible) 표시

### 작업 3. 계약 (짧음)
- `target.yaml`의 `architecture` 설명 "AWS 전용" → 클라우드별 버전(`aws-architecture.v1`, `azure-architecture.v1`)을 받는 선택 필드로
- Azure 구현 제약 절에 "architecture는 compute만 적용, 영역 중복·DB HA 미적용" 한 줄
- 변경 이력 추가 (GCP v0.1.2, Azure v0.1.3 다음 번호)

### 순서와 의존
1. PR #12 머지 대기 (작업 2·3은 그 코드 위에서). 작업 1은 `feat/azure` 위에서 먼저 구현
2. 작업 1 → 작업 3 → 작업 2 (PR #12 코드 위라 태윤 님께 공유)
3. 실측: 실제 Azure에서 medium 적용 → 복제본 2개 이상, 부하 시 확장되는지, 비용 확인

## 13. DB 엔진 (PostgreSQL · MySQL · MongoDB, AWS와 같은 범위)
스택 하나에 DB 엔진 하나다 (AWS `HACKATHON_DATABASE_ENGINE`과 같은 원칙). 다른 엔진은 새 리소스 그룹에 만들고 어댑터 설정을 그 스택으로 바꾼다. 같은 리소스 그룹을 다른 엔진으로 다시 돌리면 `provision.sh`가 멈춘다(데이터 이전 없음).

```sh
AZURE_DATABASE_ENGINE=mysql   AZURE_RESOURCE_GROUP=rg-shakedown-mysql AZURE_CONFIG=.data/azure/mysql.json bash infra/azure/scripts/provision.sh
AZURE_DATABASE_ENGINE=mongodb AZURE_RESOURCE_GROUP=rg-shakedown-mongo AZURE_CONFIG=.data/azure/mongo.json bash infra/azure/scripts/provision.sh
```

| 엔진 | Azure 서비스 | 네트워크 | AWS 대응 |
|---|---|---|---|
| `postgres` | PostgreSQL Flexible 17, B1ms | 위임 서브넷 + 사설 DNS | RDS PostgreSQL 17 |
| `mysql` | MySQL Flexible 8.0, B1ms (안정 API의 최신. 8.4는 preview API) | 위임 서브넷 + 사설 DNS, TLS 필수 | RDS MySQL 8.4 |
| `mongodb` | Cosmos DB for MongoDB vCore 8.0, M10 · 샤드 1 | private endpoint (`privatelink.mongocluster.cosmos.azure.com`) | EC2 3대 TLS 레플리카셋 |

바인딩과 비밀 (어댑터는 비밀값을 모르고 Key Vault 주소만 안다):

| 바인딩 / 참조 | Azure에서 |
|---|---|
| `host`·`port`·`name`·`username`·`jdbc_url` | 평문 환경변수 (`databaseEnvironment`, AWS와 같은 값) |
| `password` | Key Vault `db-password` |
| `postgres_url`·`mysql_url`·`mongodb_url` | Key Vault `db-url`. Bicep이 비밀번호를 URL 인코딩해 만든다 (`packages/contracts` `databaseUrl`과 같은 모양, Cosmos는 `mongodb+srv` + SCRAM + `retrywrites=false`) |
| `secret_refs` | `db_password`, `db_url`, 그리고 설정 `secrets`에 등록한 Key Vault 비밀 (외부 DB 접속 문자열 등). 앱 관리 ID가 그 볼트를 읽을 수 있어야 한다 |
| `init_command` | `sd-init` Container Apps 작업이 같은 이미지·환경변수로 한 번 실행하고 성공해야 앱을 갱신한다 (AWS `schema_init` 단계와 같음) |

- MongoDB 스택은 `mongodb_url`(과 `name`)만 받는다. Cosmos vCore는 SRV 주소 하나로 접속해서 `host`·`port`·`password`를 따로 조합한 주소는 맞지 않는다 (AWS도 MongoDB는 `mongodb_url`만).
- 기존 Spring 샘플 요청(`runtime` 없음)은 PostgreSQL 스택에서만 받는다.
- 이전 템플릿으로 만든 스택(2026-10-09 PostgreSQL)에는 `db-url` 비밀이 없어 `postgres_url` 바인딩은 400이다. `provision.sh`를 다시 돌리면 `sd-init` 작업만 추가되고 앱·DB는 그대로다.
- 검증: 가짜 Azure로 엔진별 바인딩·비밀·초기화 작업 테스트 (`test/azure-provider.test.ts`), Bicep 3개 `az bicep build` 통과. 실제 MySQL·MongoDB 스택 생성은 아직 안 함.

