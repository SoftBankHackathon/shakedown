# Terraform 이식 명세 — AWS·GCP

- 작성: 2026-10-10, 서동옥
- 기준 코드: `SoftBankHackathon/shakedown` origin/main
- 상태: **1차 구현 완료, 실계정 미검증.** 실제 계정으로 테스트할 수 없어 명세를 먼저 쓰고 그대로 구현했다. 신뢰도가 낮은 항목은 실계정에서 확인할 때까지 "미검증"으로 표시한다.
  - GCP: `infra/gcp/terraform/` + `infra/gcp/scripts/terraform.sh`. `terraform validate`, 가짜 provider 시험 4개 통과, 설정 파일 `loadConfig` 통과
  - AWS(PostgreSQL·MySQL·MongoDB): `infra/aws/terraform/` + `infra/aws/scripts/terraform.sh`. `terraform validate`, 가짜 provider 시험 6개 통과, 설정 파일 `loadConfig` 통과(세 엔진), Mongo 부트스트랩 치환 결과 `bash -n` 통과
  - 온프레미스 호스트(AWS EC2): `infra/onprem/terraform/` + `infra/onprem/scripts/terraform.sh`. `terraform validate`, 가짜 provider 시험 4개, 렌더링한 부트스트랩 `bash -n` 통과
  - 남은 것: 실계정 별도 스택 시험(§0.2), 온프레미스 엔진 연결(§3.4)
  - 구현하며 바꾼 것: Google provider는 명세의 6.x가 아니라 최신 8.x(`~> 8.0`). DB 보호 가드는 엔진 비교 대신 래퍼가 plan JSON에서 DB 자원(RDS·Mongo EC2/EBS, Cloud SQL)의 삭제·교체를 찾아 막는다(AWS·GCP 공통). `/simplify` 정리 반영(2026-10-10)

---

## 0. 공통 원칙 (Azure Terraform과 같게)

Azure는 `infra/azure/terraform` + `scripts/terraform.sh`로 먼저 옮겼다. AWS와 GCP도 같은 틀을 따른다.

| 항목 | 규칙 |
|---|---|
| 위치 | `infra/<cloud>/terraform/{versions,variables,main,outputs}.tf` + `infra/<cloud>/scripts/terraform.sh` |
| 상태 파일 | local backend, `.data/<cloud>/terraform/`에 둔다(gitignore). 래퍼가 디렉터리 권한을 700으로 만든다. 스택마다 workspace 하나 |
| 비밀값 | 상태 파일에 DB 비밀번호가 들어간다는 것을 받아들이고, 위 권한으로 보호한다(Azure와 같은 방식). write-only 속성은 선택 과제(§2.4) |
| 계정 가드 | 래퍼가 현재 로그인한 계정·프로젝트가 인자와 다르면 아무것도 하지 않고 멈춘다 |
| 산출물 | 어댑터 설정 JSON을 `local_file`로 0600 권한으로 쓴다. 키 이름은 각 어댑터의 `src/config.ts` 스키마와 같아야 한다 |
| apply 뒤 검증 | 래퍼가 어댑터의 `loadConfig()`로 설정 파일을 바로 검사한다. 스키마가 `.strict()`라 키가 남거나 모자라면 실패한다 |
| 어댑터와의 경계 | 어댑터가 배포 때 바꾸는 속성은 Terraform이 소유하지 않는다. 미리 만들어야 하는 자원은 `ignore_changes`, 어댑터가 직접 만드는 자원은 Terraform 밖에 둔다 |
| 기존 스크립트 | `provision.sh`는 지우지 않고 병행한다. 테스트와 엔진 오류 문구가 이 스크립트를 가리키기 때문이다 |

### 0.1 테스트 없이 확인할 수 있는 것 (실계정 없이)

1. `terraform fmt -check`, `terraform init -backend=false && terraform validate`: 문법, 속성 이름, 타입
2. `tflint`(provider 규칙셋): 잘못된 SKU·리전·인스턴스 타입 같은 값
3. 설정 파일 계약 테스트: `outputs.tf`의 `adapter_config`와 같은 모양의 고정 JSON을 만들어 어댑터 `loadConfig()`에 넣는다. Terraform 없이 vitest로 돌릴 수 있다
4. `terraform plan`은 자격 증명이 있어야 해서 이 단계에서는 하지 않는다

### 0.2 실계정 테스트 방법: 기존 인프라 옆에 별도 스택 (계정 담당자용)

**원칙: 기존 데모 인프라는 지우지도, 가져오지도(import) 않는다.** 이름이 다른 스택을 옆에 하나 더 만들어서 확인하고, 끝나면 그것만 지운다.

| 방법 | 기존 인프라 영향 | 언제 |
|---|---|---|
| **① 별도 스택 (이 절)** | 없음. 확인하는 동안 비용만 두 배 | 최종 데모 뒤 바로 |
| ② 기존 인프라 import | 첫 apply가 설정을 바꿀 위험 (GCP DB 비밀번호, AWS는 CloudFormation과 이중 관리) | ①이 통과한 뒤에만 |
| ③ 전부 지우고 다시 만들기 | 실패하면 데모 환경이 없어진다 | 하지 않는다 |

#### 공통 절차

1. 계정 담당자 PC에서 로그인을 확인한다. AWS는 재환님, GCP는 태현님이다.
2. 별도 스택 이름으로 `plan` → 사람이 계획을 읽고 **기존 자원을 바꾸거나 지우는 줄이 없는지** 확인한다.
3. `apply` → 설정 파일이 `.data/<cloud>/<스택>.json`에 생기고 `loadConfig`가 통과하는지 확인한다.
4. 그 설정 파일로 어댑터를 **다른 포트**로 띄운다. 기존 어댑터와 상태 DB를 같이 쓰지 않게 하려는 것이다.
5. 엔진에서 Local + 해당 클라우드로 배포한다. 샘플 앱(kty-board)으로 시운전 PASS/BLOCKED가 나오는지 본다.
6. `apply`를 한 번 더 → **변경 없음(no-op)**이어야 한다. 어댑터가 배포한 뒤에도 no-op인지 본다. 아니면 §1.6/§2.3의 `ignore_changes`가 빠진 것이다.
7. 어댑터 DELETE로 앱을 내린다 → `destroy` → 콘솔에서 남은 자원을 확인한다. 남는 것(스냅샷, 로그 등)은 이 문서에 적는다.
8. 결과와 걸린 시간, 기존 스크립트로 만든 스택과의 기본값 차이를 이 문서 "실측 기록"에 적는다.

#### AWS 별도 스택 (재환님)

- 이름: `name = "shakedown-tf"`, workspace도 `shakedown-tf-<엔진>`. ECR·로그그룹·ECS 이름이 모두 `name`을 따라가므로 기존 `shakedown-board`와 겹치지 않는다.
- VPC를 새로 만드는 구조라 네트워크는 기존 스택과 겹치지 않는다. 대역이 같은 10.42.0.0/16이어도 VPC가 다르면 문제없다.
- 1차는 `database_engine = "postgres"`만 한다. Mongo는 §1.5 설계 확정 뒤에 한다.
- `enable_mongo_snapshots = false`
- 확인 중 추가 비용(대략): ALB, RDS t3.micro, 공인 IP. 몇 시간이면 몇 달러 수준이다. 끝나면 바로 destroy한다.

#### GCP 별도 스택 (태현님)

- **사설 네트워크 연결(PSA 피어링)은 새로 만들지 않는다.** 프로젝트의 `default` 네트워크에 피어링이 이미 있어서, 새로 만들면 생성이 실패하거나 기존 대역 목록을 덮어쓴다. 별도 스택은 이 둘을 `data`로 읽어서 쓴다.
  - 변수 `create_private_service_access = false`
  - 기존 `shakedown-psa` 대역과 연결을 읽어서 사용한다
- 이름에 접미사를 붙인다
  - Cloud SQL `shakedown-pg-tf`
  - 비밀 `shakedown-tf-db-password`
  - 설정의 `serviceName = "shakedown-board-tf"`, `jobName = "shakedown-board-tf-schema"`
  - Artifact Registry 저장소는 기존 `shakedown`을 같이 써도 된다. 이미지 digest가 달라서 섞이지 않는다
- 무료 체험 쿼터: 서울 Cloud Run 20 vCPU. 기존 서비스가 떠 있는 상태에서 별도 스택도 띄우면 합계를 넘지 않는지 먼저 본다.
- Cloud SQL 인스턴스 이름은 지운 뒤 한동안 다시 쓸 수 없을 수 있다(미검증). 재시험할 때는 `-tf2`처럼 새 이름을 쓴다.
- 끝나면 Cloud Run 서비스와 Job을 gcloud로 먼저 지우고, 그다음 destroy한다. `deletion_protection=false`로 한 번 apply한 뒤 destroy한다.

#### 실측 기록

| 날짜 | 클라우드 | 담당 | apply 시간 | 시운전 | 재apply no-op | destroy 뒤 남은 것 | 메모 |
|---|---|---|---|---|---|---|---|
| | AWS | 김재환 | | | | | |
| | GCP | 김태현 | | | | | |

---

## 1. AWS

`F:`는 `infra/aws/cloudformation/foundation.yaml`, `P:`는 `infra/aws/src/aws-provider.ts`의 행 번호다.

### 1.1 범위 결론

- provider: `hashicorp/aws ~> 6.0` (6.x 전용 기능은 쓰지 않아서 `~> 5.90`에서도 동작), `random`, `local`, `time`
- **Terraform이 만드는 것:** CloudFormation 템플릿에 있는 자원 51개 전부. VPC·서브넷·SG, ALB·TG·리스너·게이트 규칙, ECR·로그·ECS 클러스터, IAM, RDS, Mongo EC2 3대·EBS, Secrets, DLM
- **Terraform이 만들지 않는 것**
  - **어댑터가 만드는 것:** ECS 서비스, 태스크 정의, AppAutoScaling (`P:73, 116-125, 253-259`)
  - **HTTPS 서비스(`infra/https`)가 만드는 것:** ACM, 443 리스너, SG 443 규칙
  - 위 두 가지는 템플릿에도 원래 없다
- 커스텀 리소스, Lambda, Transform, 중첩 스택은 **없다.** 직접 대응이 없는 것은 WaitCondition 하나뿐이다(§1.5)
- 예상 규모: `.tf` 9~10개, 약 900~1,100줄. Mongo 부트스트랩은 기존 `scripts/mongodb-node.sh`를 `file()`로 그대로 읽는다(§1.5). 여기에 `scripts/terraform.sh`(약 100줄)를 더한다. CFN 1,379줄 중 약 300줄은 UserData를 3번 복제한 부분이라 실제로는 줄어든다

### 1.2 입력 변수 (CFN Parameters → variables.tf)

| CFN Parameter | Terraform 변수 | 기본값 | 비고 |
|---|---|---|---|
| Name | `name` | `shakedown-board` | `[a-z][a-z0-9-]{2,29}`. ECR·로그·서비스 이름에 쓰인다 |
| CreateDatabase | `create_database` | true | |
| DatabaseEngine | `database_engine` | postgres | postgres / mysql / mongodb |
| PostgresVersion | `postgres_version` | **없음(필수)** | `17\.[0-9]+`. 스크립트 기본 17.1은 지원 중단됐을 수 있다(§1.8) |
| MysqlVersion | `mysql_version` | 8.4.7 | |
| DatabaseName | `db_name` | board_db | |
| AppPort | `app_port` | 8080 | |
| AdditionalSecretArns / KmsKeyArns | `additional_secret_arns` / `additional_kms_key_arns` | [] | 실행 역할이 읽을 외부 Secret |
| EnableMongoSnapshots | `enable_mongo_snapshots` | **false로 변경** | 실험 계정에서 DLM이 SCP로 막혀 있었다 |
| MongoAmi | `data "aws_ssm_parameter"` | AL2023 최신 | |

CFN Conditions(`F:56-97`)는 `count`/`for_each`와 `dynamic` 블록으로 옮긴다: WithDatabase, WithRds, WithMongo, WithMysql, WithMongoSnapshots, WithAdditionalSecrets, WithAdditionalKmsKeys.

### 1.3 provision.sh 동작 중 Terraform으로 옮겨야 하는 것

| provision.sh | Terraform 대응 |
|---|---|
| 리전 `ap-northeast-2` 고정, `default` 프로필 거부, STS로 계정 대조 (L7-11) | provider의 `region`, `profile`, `allowed_account_ids` + 래퍼 가드 |
| 기존 스택과 엔진이 다르면 거부 (L23-27) | Terraform에는 이 개념이 없다. 변수 하나만 바꿔도 RDS를 지우고 Mongo를 만드는 계획이 나온다 → 래퍼가 apply 전에 `plan -out` → `show -json`에서 DB 자원(`aws_db_instance`, Mongo `aws_instance`·`aws_ebs_volume`)의 delete를 찾으면 멈춘다. 엔진뿐 아니라 DB 이름·AZ 변경 등 모든 교체 원인을 막는다. `HACKATHON_ALLOW_DATA_LOSS=1`로만 통과 |
| RDS orderable 확인 (L36-37) | `data "aws_rds_orderable_db_instance"` + precondition |
| 값을 생략하면 이전 값을 유지 (CFN UsePreviousValue) | Terraform에는 없다 → workspace별 tfvars 파일을 `.data/aws/terraform/`에 보관 |
| `CAPABILITY_IAM` 자동 이름 | IAM은 `name_prefix` |
| `compact-template.mjs`, `render-mongo.mjs` | Terraform에는 필요 없다. 다만 CFN 경로와 테스트가 계속 쓰므로 그대로 둔다 |

### 1.4 자원 대응표

| 영역 | CFN | Terraform | 주의 | 신뢰도 |
|---|---|---|---|---|
| 네트워크 | Vpc 10.42.0.0/16, IGW, Public A/B/C(/24), Private A/B(WithRds), 라우트 | `aws_vpc`, `aws_internet_gateway`, `aws_subnet` ×5, `aws_route_table`, `aws_route`, `aws_route_table_association` ×3, `data "aws_availability_zones"` | 기본 VPC는 쓰지 않는다. NAT 없음. Fargate와 Mongo는 공인 IP | 높음 |
| SG | AlbSg(80 ← 0.0.0.0/0), AppSg(앱 포트 ← AlbSg), DbSg(3306/5432 ← AppSg), MongoSg(27017 ← AppSg, self) | `aws_security_group` + **규칙은 모두 별도 리소스** `aws_vpc_security_group_ingress_rule` / `_egress_rule` | **egress를 반드시 명시한다**(§1.8 위험 1). AlbSg 443은 HTTPS 서비스가 붙였다 뗐다 하므로 인라인 `ingress`를 쓰면 다음 apply에서 지워진다 | 중간 |
| ALB | Alb(internet-facing, 서브넷 3개), TargetGroup(ip, HC `/`, stickiness off, round_robin, dereg 5), Listener 80, TrafficGate(priority 1, 403 고정 응답) | `aws_lb`, `aws_lb_target_group`, `aws_lb_listener`, `aws_lb_listener_rule` | ALB와 TG 이름은 32자 이하. TG는 `name_prefix`(6자 이하)로 두어 포트 변경 시 교체 충돌을 피한다 | 높음 |
| ECR·로그·클러스터 | Repository(**Retain**, IMMUTABLE, scanOnPush), Logs(**Retain**, `/shakedown/<Name>`, 7일), Cluster | `aws_ecr_repository`, `aws_cloudwatch_log_group`(`skip_destroy=true`), `aws_ecs_cluster`(Terraform은 name 필수) | 예전 CFN 스택이 Retain으로 남긴 같은 이름이 있으면 `AlreadyExists` → import | 높음 |
| IAM | ExecutionRole(ECR pull, logs, 조건부 Secret·KMS), TaskRole(빈 역할), AdapterPolicy·ImagePublisherPolicy(붙이지 않고 출력만) | `aws_iam_role`, `aws_iam_policy_document` + `dynamic statement`, `aws_iam_policy` | 조건부 statement 다섯 종류와 ARN 형식(`service/${cluster}/${name}`) | 중간~높음 |
| RDS | DbSubnets, Database(db.t3.micro, 20GB gp3, 암호화, 비공개, `board_admin`, backup 1일, **Snapshot**) | `aws_db_subnet_group`, `aws_db_instance` | `skip_final_snapshot=false` + 고정된 `final_snapshot_identifier`(타임스탬프를 쓰면 매번 diff). `dbHost`에는 `.address`를 쓴다(`.endpoint`는 `:port`가 붙음) | 중간 |
| Secrets | DbSecret(**Retain**, 비밀번호 32자, 제외 `"@/\`), DbUrlSecret, MongoClusterSecret, MongoCaSecret(모두 Retain, 초기값 `{}`) | `aws_secretsmanager_secret`(`name_prefix`) + `_version` | 초기 `{}` 버전은 **반드시** 있어야 한다. 어댑터와 UserData가 버전이 없으면 실패한다(`database-url.ts:23`, `F:464`) | 중간 |
| Mongo | MongoRole·Profile, MongoData 1~3(EBS 20GB, **Snapshot**), Attachment 1~3, MongoInstance 1~3(t3.small, IMDSv2, 고정 IP 10.42.{0,1,2}.50, UserData 약 100줄) | `aws_iam_role`·`_instance_profile`, `aws_ebs_volume`(`final_snapshot=true`), `aws_volume_attachment`, `aws_instance` + `file()`·`replace()` (§1.5) | `${AWS::Region}` 같은 CFN 문법 때문에 `templatefile`은 쓸 수 없다. 인스턴스는 라우트가 생긴 뒤에 만들어야 한다(dnf·docker pull) → `depends_on` | 중간~낮음 |
| Mongo 준비 대기 | **MongoReadyHandle / MongoReady (WaitCondition, 1800초)** | **대응 없음** → §1.5 | | 낮음 |
| DLM | MongoSnapshotRole, LifecyclePolicy(매일 18:00, 7개 보존) | `aws_iam_role`, `aws_dlm_lifecycle_policy` | 기본값 false로 | 중간 |

### 1.5 WaitCondition 대체 설계 (구현함, 실계정 미검증)

지금은 Mongo 노드0의 UserData가 3멤버가 모두 healthy인 것을 확인한 뒤 `curl PUT`으로 CFN 핸들에 신호를 보낸다(`F:531`). 그동안 CFN은 최대 1800초를 기다린다.

- **문제:** Terraform에는 핸들이 없다. 그런데 스크립트가 `set -e` 아래에서 `curl "$ready_handle"`을 부르므로, 핸들이 비어 있으면 부트스트랩 자체가 실패로 끝난다.
- **스크립트는 고치지 않았다.** `render-mongo.mjs`와 테스트가 YAML과 스크립트가 같은지 확인하기 때문이다. 대신 `mongo.tf`가 `file()`로 읽어 CFN 치환값을 바꾸고 신호 줄만 지운다. 스크립트가 바뀌어 치환할 곳을 못 찾으면 plan이 precondition으로 멈춘다.
- **대기 방식:** `terraform.sh apply` 뒤에 래퍼가 DbUrlSecret 값이 `mongodb://`로 시작할 때까지 최대 30분 폴링한다. `terraform_data` + local-exec도 가능하지만, 래퍼에 두는 편이 Azure와 구조가 같다.
- **안전성:** 준비가 끝나기 전에 배포해도 어댑터가 URL을 검증하므로 안전하게 실패한다(`database-url.ts:12-14`).

### 1.6 어댑터·HTTPS 서비스와의 경계 (`ignore_changes`)

| 리소스 | 런타임에 바꾸는 주체 | Terraform 처리 |
|---|---|---|
| `aws_lb_listener_rule.gate` | 어댑터가 forward와 403을 오간다(`P:48-51`). HTTPS 서비스도 redirect와 403을 쓴다 | `ignore_changes = [action]` |
| `aws_lb_target_group` | 어댑터가 `health_path`를 바꾼다(`P:112`) | `ignore_changes = [health_check[0].path]`. 나머지 속성(stickiness off, round_robin, dereg 5)은 어댑터가 쓰는 값과 똑같이 선언해 드리프트를 없앤다 |
| `aws_db_instance` | 어댑터가 MultiAZ를 바꾼다(`P:248`, README:178) | `ignore_changes = [multi_az, engine_version]`. engine_version은 자동 마이너 업그레이드 뒤 다운그레이드를 시도하지 않게 하려는 것 |
| AlbSg | HTTPS 서비스가 443 ingress를 붙였다 뗀다 | 규칙을 별도 리소스로 분리 (§1.4) |
| DbUrl·MongoCluster·MongoCa Secret 버전 | 어댑터(`database-url.ts:26`)와 Mongo UserData가 실제 값을 쓴다 | `ignore_changes = [secret_string, version_stages]` |
| `aws_instance` (Mongo) | 런타임 변경은 없다. 하지만 SSM AMI 값이 갱신되면 3대가 동시에 교체된다 | `ignore_changes = [ami, user_data]` |

**어댑터가 만드는 것은 Terraform이 관리하지 않는다:** ECS 서비스(이름 = `name`), 태스크 정의(family = `name`), AppAutoScaling, 서비스 연결 역할(SLR). SLR을 `aws_iam_service_linked_role`로 만들면 이미 있을 때 충돌한다.

### 1.7 어댑터 설정 파일 매핑 (`infra/aws/src/config.ts`)

지금은 `config-from-outputs.ts`가 CFN 출력 이름의 첫 글자를 소문자로 바꿔 그대로 쓴다. Terraform에서는 `outputs.tf`의 `local.adapter_config` → `local_file`로 바꾼다.

| 키 | Terraform 값 |
|---|---|
| `port` | `var.app_port` (숫자) |
| `clusterArn` | `aws_ecs_cluster.arn` |
| `repositoryUri` / `repository` | `aws_ecr_repository.repository_url` / `.name` |
| `serviceName` | `var.name` |
| `listenerArn` / `gateRuleArn` / `targetGroupArn` | 각 `.arn` |
| `publicUrl` | `"http://${aws_lb.dns_name}"` (http이고 `*.elb.amazonaws.com`이어야 함) |
| `subnetIds` | Public A/B/C id |
| `securityGroupId` | AppSg id |
| `executionRoleArn` / `taskRoleArn` | 각 `.arn` |
| `logGroup` | `.name` (`/shakedown/`로 시작) |
| `dbEngine` / `dbName` | 변수 |
| `dbInstanceId` | Mongo면 `aws_instance[0].id`, 아니면 `aws_db_instance.identifier` |
| `dbHost` | Mongo면 노드0 사설 IP, 아니면 `aws_db_instance.address` |
| `dbUsername` | Mongo면 `"app"`, 아니면 `"board_admin"` |
| `dbPasswordSecretArn` / `dbUrlSecretArn` | 각 Secret `.arn` |
| `dbHosts` / `dbInstanceIds` / `dbCaSecretArn` | Mongo만. `["10.42.0.50","10.42.1.50","10.42.2.50"]` / `aws_instance[*].id` / CA Secret `.arn` |
| `region` | 상수 `ap-northeast-2` |
| `profile`, `accountId`, `projectId`, `httpsControlUrl`, `secrets` | 래퍼 인자로 받는다 (출력에서 오지 않음) |

AdapterPolicyArn과 ImagePublisherPolicyArn은 설정에 들어가지 않는다. 운영자가 principal에 붙이도록 output으로만 낸다.

### 1.8 위험 목록

| # | 위험 | 대응 |
|---|---|---|
| 1 | **SG egress가 사라진다.** Terraform `aws_security_group`은 AWS 기본 allow-all egress를 지운다. 명시하지 않으면 ECR pull, 로그, Secrets, Mongo의 dnf·docker·SSM이 전부 막힌다. **가장 위험한 함정** | 모든 SG에 egress 규칙을 명시 |
| 2 | 인라인 규칙과 별도 규칙 리소스를 섞으면 서로 지운다 | 별도 리소스로 통일 |
| 3 | 예전 CFN 스택이 Retain으로 남긴 ECR, 로그그룹, Secret과 이름 충돌. Secret은 삭제 뒤 30일 동안 이름이 예약된다 | import 또는 `name_prefix` |
| 4 | Retain/Snapshot 정책은 Terraform에 직접 대응이 없다 | RDS final snapshot, EBS `final_snapshot`, 로그 `skip_destroy`, ECR `force_delete=false` |
| 5 | destroy 순서: 어댑터가 만든 ECS 서비스가 남아 있으면 클러스터와 TG 삭제가 실패한다. Fargate ENI 때문에 SG와 서브넷 삭제가 지연된다 | 어댑터 DELETE를 먼저 하고 destroy |
| 6 | 엔진·DB 이름 변경 등으로 DB가 교체된다 | 래퍼의 plan JSON 가드 (§1.3) |
| 7 | PostgreSQL 17.1이 지원 중단됐을 수 있다 | orderable data source로 plan 단계에서 막기 |
| 8 | DLM이 SCP로 막힌 계정이 있다 | 기본 false |
| 9 | 이미 검증된 경로를 벗어난다. MySQL·Mongo는 CFN으로 실계정 검증이 끝났지만(`docs/experiments/2026-10-10-database-live-validation.md`), Terraform 이식본은 그 검증을 이어받지 못한다 | 인수 체크리스트 §0.2 |
| 10 | 기존 테스트가 `foundation.yaml`을 직접 파싱한다(`test/aws-provider.test.ts`, `experiments/*.py`) | CFN은 지우지 않고 병행 |

**비용(서울, 월 대략):** ALB 약 $16, 공인 IPv4 개당 약 $3.6, RDS t3.micro 약 $22, Mongo 3대와 EBS 약 $65, Fargate 태스크당 약 $22, Secret 개당 $0.4

### 1.9 이식하다 발견한 기존 버그

- AdapterPolicy에 `ec2:DescribeInstances`가 없는데(`F:802-807`), Mongo 상태 확인 `checkMongo`가 이를 호출한다(`P:225`). Terraform 이식본에서는 추가할지, 재환님께 먼저 알릴지 정해야 한다.

### 1.10 정해야 할 것

- [ ] 비밀번호: Azure 방식(상태 파일에 평문을 두고 보호)으로 갈지, write-only로 갈지 → 기본은 Azure 방식
- [x] Mongo 경로 → 구현함 (§1.5)
- [x] `ec2:DescribeInstances` → Terraform AdapterPolicy에는 넣었다. CFN 쪽은 재환님께 알릴 것
- [ ] CloudFormation 병행 → 기본은 병행

---

## 2. GCP

### 2.1 범위 결론

- provider: `hashicorp/google ~> 6.x`, `random`, `local`, `time`. **google-beta는 필요 없다**(모두 GA 자원).
- **Terraform이 만드는 것:** API 8개, Artifact Registry, 사설 서비스 연결(PSA) 대역과 피어링, Cloud SQL(인스턴스·DB·사용자), Secret Manager(비밀·버전), 비밀 읽기 IAM, 어댑터 설정 파일
- **Terraform이 만들지 않는 것:** Cloud Run 서비스, Cloud Run Job, `run.invoker` IAM. 이유는 §2.3
- 예상 규모: 파일 5개, 약 350~420줄 (Azure 624줄보다 작다)

### 2.2 자원 대응표 (`infra/gcp/scripts/provision.sh` → Terraform)

| # | provision.sh | Terraform 자원 | 주요 값 | 신뢰도 |
|---|---|---|---|---|
| 1 | `services enable` 8개 (L27-29) | `google_project_service` × 8 (`for_each`) | run, sqladmin, compute, servicenetworking, secretmanager, artifactregistry, cloudresourcemanager, logging. `disable_on_destroy=false` | 높음 |
| 2 | `projects describe` 번호 (L30-31) | `data "google_project"` | `.number` → 설정의 `gcpProjectNumber`, 기본 SA 이름 | 중간¹ |
| 3 | `artifacts repositories create shakedown` (L34-36) | `google_artifact_registry_repository` | `repository_id="shakedown"`, `format="DOCKER"`, `location="asia-northeast3"` | 높음 |
| 4 | `compute addresses create shakedown-psa` (L40-42) | `google_compute_global_address` | `purpose="VPC_PEERING"`, `address_type="INTERNAL"`, `prefix_length=16`, `network=default`. `address`는 비워서 Google이 고르게 한다 | 높음 |
| 5 | `vpc-peerings connect` (L43-45) | `google_service_networking_connection` | `reserved_peering_ranges=[주소 이름]`, `deletion_policy="ABANDON"`. **`create_private_service_access=false`이면 4·5를 만들지 않고 `data`로 기존 것을 읽는다**(별도 스택용, §0.2) | 중간² |
| 6 | `sql instances create shakedown-pg` (L50-68) | `google_sql_database_instance` | `POSTGRES_17`, `settings.edition="ENTERPRISE"`(**필수**: PG16 이상은 기본이 Enterprise Plus라 db-f1-micro를 못 씀), `tier="db-f1-micro"`, `availability_type="ZONAL"`, `ipv4_enabled=false`, `private_network=default`, `depends_on=[연결]` | 중간³ |
| 7 | 사설 IP 읽기 (L70-71) | `.private_ip_address` | → 설정의 `dbHost` | 높음 |
| 8 | `sql databases create board_db` (L74-76) | `google_sql_database` | `deletion_policy="ABANDON"` | 높음 |
| 9 | `secrets create shakedown-db-password` (L83-85) | `google_secret_manager_secret` | `replication { auto {} }` (6.x는 `automatic=true`가 아님) | 높음 |
| 10 | 비밀번호 생성 + `versions add` (L88-91) | `random_password` + `google_secret_manager_secret_version` | `length=48, special=false` (지금은 hex 48자) | 높음 |
| 11 | `sql users create board` (L96-106) | `google_sql_user` | `name="board"`, `deletion_policy="ABANDON"`(앱 테이블을 이 사용자가 소유해서 DROP ROLE이 실패함) | 중간 |
| 12 | 비밀 IAM (L113-114) | `google_secret_manager_secret_iam_member` | `${번호}-compute@developer.gserviceaccount.com` → `roles/secretmanager.secretAccessor`. **`_iam_policy`/`_iam_binding` 금지**(다른 권한을 지움) | 중간~높음⁴ |
| 13 | 설정 JSON (L118-138) | `local_file` | §2.5 | 높음 |

¹ 새 프로젝트에서는 plan 시점에 compute API가 꺼져 있어 `data "google_compute_network"`가 실패할 수 있다. data source에 `depends_on`을 걸거나 API만 먼저 `-target` apply한다.
² 프로젝트에 이미 피어링이 있으면 생성이 실패한다. provision.sh는 "하나라도 있으면 건너뜀"이었다. 기존 프로젝트는 import로 가져온다. destroy는 Cloud SQL 삭제 직후 "producer services still using this connection"으로 자주 실패해서 ABANDON으로 둔다.
³ gcloud와 Terraform의 기본값이 다르다. gcloud는 자동 백업이 켜지고, Terraform은 `backup_configuration.enabled`가 false다. 백업, PITR, 디스크(10GB SSD, autoresize), 유지보수 창을 명시해서 맞춘다. `ssl_mode`는 평문 허용(기본)을 유지한다. 어댑터가 sslmode 없는 JDBC로 접속하기 때문이다.
⁴ Compute 기본 SA는 compute API를 켠 뒤 비동기로 생긴다. API를 켠 뒤 `time_sleep` 60초를 둔다(Azure의 RBAC 90초 대기와 같은 이유).

### 2.3 Terraform 밖에 두는 것과 이유

| 자원 | 어댑터 동작 | 결정 |
|---|---|---|
| Cloud Run 서비스 `shakedown-board` | `PATCH ?allowMissing=true`로 **updateMask 없이 전체 교체**한다. 첫 배포 때 생성하고, 이미지·env·리소스·VPC 연결·세션 고정·스케일을 매번 다시 쓴다 (`src/cloud-run.ts:65-69`, `src/gcp-provider.ts:119-150`) | 만들지 않는다. Terraform이 넣은 값은 첫 배포에서 지워져서 `ignore_changes = all`밖에 답이 없다. 미리 만들면 어댑터의 "첫 배포" 순서도 바뀐다. 6.x는 `deletion_protection` 기본값이 true라 destroy도 막힌다 |
| Cloud Run Job `shakedown-board-schema` | 같은 방식으로 전체 교체한 뒤 `:run` (`cloud-run.ts:101-104`) | 만들지 않는다 |
| `roles/run.invoker` → `allUsers` | 배포 때 넣고 차단(DELETE) 때 빼는 read-modify-write. etag를 보존한다 (`cloud-run.ts:82-98`) | **절대 Terraform으로 관리하지 않는다.** policy/binding은 apply 때마다 어댑터의 상태를 덮어써서 "차단한 서비스가 다시 공개되는" 사고가 난다. `_iam_member(allUsers)`도 차단과 싸운다 |

Azure와 다른 점: Azure 어댑터는 Container App이 미리 있어야 해서 placeholder로 만들고 `ignore_changes`를 둔다. GCP 어댑터는 직접 만들기 때문에 placeholder가 필요 없다.

삭제 순서: Cloud Run 서비스와 Job을 gcloud로 먼저 지운다(README 4단계). 그다음 `terraform destroy`를 한다. Direct VPC egress가 서브넷 IP를 잡고 있기 때문이다.

### 2.4 비밀번호

- **채택: Azure와 같은 방식(a).** `random_password`를 일반 속성으로 쓰고 상태 파일을 700 권한으로 보호한다. 평문이 상태에 세 번 들어간다(`random_password`, `secret_version.secret_data`, `sql_user.password`).
- 선택 과제(b): write-only로 바꾸기
  - `ephemeral "random_password"`, `secret_data_wo`, `password_wo`를 쓴다
  - Terraform ≥ 1.11과 google provider 6.2x 이상이 필요하다. **정확한 최소 버전 미확인**
  - 두 `_wo_version`은 반드시 하나의 변수로 같이 올린다. 따로 올리면 비밀과 DB 사용자 비밀번호가 어긋난다
- 회전 주의: 비밀번호를 바꾸면 Cloud SQL에는 바로 반영된다. 하지만 떠 있는 Cloud Run 인스턴스는 기동 때 읽은 옛 값을 계속 쓴다. 회전 뒤에는 재배포해야 한다.

### 2.5 어댑터 설정 파일 매핑 (`infra/gcp/src/config.ts`, `.strict()`)

| 키 | Terraform 값 | 비고 |
|---|---|---|
| `gcpProject` | `var.project` | |
| `gcpProjectNumber` | `tostring(data.google_project.this.number)` | 하드코딩 금지. 어댑터가 기동 때 ID와 번호를 함께 확인하고, 공개 URL도 번호로 만든다 |
| `region` | `var.region` (validation으로 `asia-northeast3` 고정) | 스키마가 literal |
| `projectId` | `var.app_project_id` (기본 `prj_board`) | 엔진 프로젝트 ID |
| `serviceName` / `jobName` | `shakedown-board` / `shakedown-board-schema` | |
| `imagePrefixes` | `["${location}-docker.pkg.dev/${project}/${repository_id}/"]` | `/`로 끝나야 함 |
| `network` / `subnetwork` | `"default"` / `"default"` | **경로가 아니라 이름** |
| `dbHost` | `google_sql_database_instance.private_ip_address` | 사설 대역이어야 함 |
| `dbName` / `dbUsername` | `board_db` / `board` | |
| `dbPasswordSecret` | `google_secret_manager_secret.secret_id` | `.id`·`.name`은 `projects/...` 경로라 쓰면 안 된다 |
| `port` / `memory` / `cpu` | `8080` / `"1Gi"` / `"1"` | cpu와 memory는 문자열 |

같은 파일을 읽는 곳이 세 군데 더 있다. 키를 바꾸면 같이 확인해야 한다.
- 엔진 `apps/engine/engine/gcp_runner.py:20-34`
- `scripts/publish-image.sh`(`imagePrefixes[0]`)
- `scripts/spike.sh`

### 2.6 Terraform 밖에 남는 절차

- 이미지 push: `publish-image.sh`(linux/amd64 → digest 출력)
- 스키마 초기화: 어댑터가 배포마다 Cloud Run Job으로 실행한다. 옮길 것 없음
- ADC 로그인과 quota project 설정(README 118-121)
- 비용 멈추기: DELETE로 0대 만들기, Cloud SQL `activation-policy=never`. Terraform이 `activation_policy`를 소유하면 다음 apply가 DB를 다시 켜니 `ignore_changes=[settings[0].activation_policy]`를 둔다

### 2.7 기존 프로젝트 `shakedown-511106` 처리

- 새로 만들지 않고 `import {}` 블록으로 가져온다: 인스턴스, DB, 사용자, 비밀과 버전, global address, 연결, AR, project_service
- `google_sql_user`의 비밀번호는 import로 읽어 올 수 없다. 그대로 두면 첫 apply가 Terraform 값으로 비밀번호를 바꿔 Secret Manager 값과 어긋난다. import할 때는 `ignore_changes=[password]`를 둔다
- 첫 plan의 차이는 반드시 사람이 확인한다(§2.2 각주 ³의 기본값 차이)
- 태현님 프로젝트이므로 import와 apply는 태현님과 함께 한다

### 2.8 위험 목록

| 위험 | 대응 |
|---|---|
| Cloud SQL `deletion_protection` 기본 true라 destroy가 막힘 | 변수로 빼고 destroy 전에 false로 apply. API의 `deletion_protection_enabled`와는 다른 속성 |
| Cloud SQL 인스턴스 이름은 삭제 뒤 최대 1주일 재사용 불가(**미검증**, README 431행과 다름) | destroy/apply 반복 시험은 접미사를 붙인 이름으로 |
| API 켠 직후 1~2분 전파 지연 | `time_sleep` 60초 |
| 무료 체험: 쿼터 상향 불가(서울 Cloud Run 20 vCPU), 크레딧 만료 2027-01-08 | apply 한 번이 과금 자원 생성(Cloud SQL 약 340초). 끝나면 비용 멈추기 |
| 사용자 ADC로 serviceusage를 부를 때의 quota project 문제 | provider에 `billing_project=var.project`, `user_project_override=true` |
| 서비스·Job이 Compute 기본 SA로 돈다 | 범위 밖. 전용 SA로 바꾸려면 어댑터 본문 변경 필요 |

### 2.9 정해야 할 것

- [ ] 비밀번호는 (a) Azure 방식으로 갈지, (b) write-only로 갈지 → 기본 (a)
- [ ] 기존 프로젝트를 import할지, 새 프로젝트를 만들지 → 태현님과 결정
- [ ] provision.sh를 계속 둘지 → 기본은 병행

---

## 3. 온프레미스 호스트 (AWS EC2로 흉내)

### 3.1 배경과 범위

- 온프레미스는 별도 어댑터가 아니다. **로컬 어댑터(`infra/local`)의 direct 모드**를 리눅스 서버 한 대에서 돌리는 구조다(#31, 김태윤).
  - `LOCAL_DELIVERY_MODE=direct`: Cloudflare Tunnel 없이 서버 주소로 바로 공개
  - 컨테이너는 `restart: unless-stopped`로 재부팅 뒤 자동 기동
  - 어댑터는 systemd 유닛(`infra/local/systemd/shakedown-local.service`)으로 자동 기동
- 실측은 AWS EC2로 했다(`docs/experiments/2026-10-10-onprem-ec2.md`, `...-direct-deployment-reboot.md`). **그 EC2를 만드는 코드는 레포에 없다.** 실험용 CloudFormation 스택으로 만들고 지웠다. 설치도 SSM으로 손으로 했다.
- 이 절은 그 EC2 호스트를 Terraform으로 다시 만들 수 있게 한다. 위치는 `infra/onprem/terraform/` + `infra/onprem/scripts/terraform.sh`.

### 3.2 실측 조건을 그대로 지킨다

| 실측 조건 | Terraform |
|---|---|
| Amazon Linux 2023, t3.medium, 암호화 EBS 24GiB | `data "aws_ssm_parameter"`(AL2023 최신), `aws_instance`, root gp3 24GiB encrypted |
| Node v22.23.2, Docker 25, Compose v5.6.0 | user_data가 Node·Compose 공식 배포본을 받아 **SHA256 체크섬을 확인한 뒤** 설치한다. Docker는 dnf. 버전은 변수 |
| 앱 포트(18080)만 허용한 IP와 **자기 공인 IP `/32`**에 연다. 자기 IP는 공개 URL 자체 health 확인에 필요하다 | SG ingress 규칙 2종. SSH·DB·9101은 열지 않는다 |
| 관리는 SSM | `AmazonSSMManagedInstanceCore` 역할. 키 페어 없음 |
| `/etc/shakedown-local.env`는 root 0600, 비밀번호는 서버에서 만든다 | 비밀번호는 Terraform이 만들어 **SSM SecureString**에 두고, 서버가 부팅 때 읽어 0600 파일에 쓴다. user_data에는 비밀번호를 넣지 않는다(EC2 API로 user_data가 읽히기 때문) |
| 공개 주소는 고정이어야 한다(문서: stop/start하면 IP가 바뀜) | **Elastic IP**. `LOCAL_PUBLIC_URL = http://<EIP>:<앱 포트>` |
| 다이어그램은 "격리 VPC". 실측은 기존 공유 VPC를 빌려 씀 | 다이어그램대로 **전용 VPC**(10.43.0.0/16, AWS 기반 스택 10.42와 겹치지 않게) |

### 3.3 코드 배치

- 레포는 private일 수 있어 서버에서 `git clone`하지 않는다.
- 래퍼가 `git archive HEAD infra/local packages/contracts`로 묶음을 만든다. 로컬 어댑터가 쓰는 것은 이 두 폴더뿐이다(외부 npm 의존성 없음). **커밋된 내용만** 들어간다.
- Terraform이 전용 S3 버킷(비공개, 암호화)에 올리고, 서버 역할은 그 객체 하나만 읽는다.
- 서버는 `/opt/shakedown`에 풀고 systemd 유닛을 등록한다.

### 3.4 남는 연결 문제 (Terraform 밖, 미해결)

- **제어 API(9101)는 loopback 전용**이다. 개발 PC의 엔진은 SSM 포트 포워딩으로 붙는다(`AWS-StartPortForwardingSession`, session-manager-plugin 필요). 공개 9101은 절대 열지 않는다.
- **이미지 전달:** 엔진은 지금 로컬 Docker에서 빌드한 이미지 이름을 넘긴다. 원격 서버의 Docker는 그 이미지를 볼 수 없다. 해결 방법은 두 가지다.
  - (a) 엔진도 이 서버에서 돌린다 (README가 말하는 "같은 호스트" 구성)
  - (b) ECR에서 pull한다 (`ecr_repository_arns` 변수 → 서버 역할에 pull 권한 + `amazon-ecr-credential-helper`). 엔진이 온프레미스 대상에 ECR digest를 넘기도록 바꾸는 것은 별도 작업이다
- 둘 다 실계정에서 확인 전이다.

### 3.5 신뢰도

| 영역 | 신뢰도 | 이유 |
|---|---|---|
| VPC·SG·EIP·IAM·S3·SSM 파라미터 | 높음 | 1:1 대응 |
| EC2 + user_data 설치 | 중간 | 실측과 같은 절차지만 자동 설치(무인 부트스트랩)는 실측에서도 "주장하지 않음"으로 남아 있었다 |
| 엔진 연결(포트 포워딩·이미지) | 낮음 | §3.4 |

### 3.6 정해야 할 것

- [ ] 엔진 연결 방식: (a) 같은 서버 / (b) ECR pull → 태윤님과
- [ ] 앱 포트 허용 IP(데모장 IP). 기본은 비워 두고 자기 IP만 연다
