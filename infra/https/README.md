# Shakedown HTTPS 자동 설정 모듈

기존 배포 리소스에 사용자 서브도메인과 인증서를 연결한다. DNS는 안내만 하고 사용자가 직접 등록한다. HTTPS 접속을 검증한 뒤 HTTP 리다이렉트를 적용한다. 앱·DB·로드밸런서의 초기 생성은 하지 않는다.

## 실행

Node.js 24 이상과 대상별 CLI(aws, az, gcloud)가 필요하다. Cloudflare와 Caddy는 HTTP API를 사용한다.

프로젝트 루트에서:

~~~sh
npm ci
cp infra/https/config.example.json infra/https/config.json
# config.json endpoints에 운영자가 확인한 전용 계정과 기존 리소스를 등록한다.
npm run dev:https
~~~

서비스는 **127.0.0.1:9301**에만 바인딩한다. 설정의 statePath는 실행 작업 디렉터리 기준이다. 별도 설정 파일은 SHAKEDOWN_HTTPS_CONFIG의 절대 경로로 지정한다. config.json과 .data는 Git에서 제외한다. 브라우저 Origin 요청을 거절하며 엔진을 통해서만 호출한다. 운영용 원격 다중 사용자 서비스의 인증/인가를 대신하는 기능은 아니다.

엔진에는 SHAKEDOWN_HTTPS_URL=http://127.0.0.1:9301을 설정한다. 이 설정이 없으면 기존 엔진 동작을 유지하며 설정 화면에는 서비스 연결 안내가 나타난다. 설정이 있는데 서비스에 연결할 수 없으면 HTTPS를 HTTP로 낮춰 계속 진행하지 않는다.

엔진의 기존 Local/AWS 대상 주소는 SHAKEDOWN_TARGET_LOCAL_URL, SHAKEDOWN_TARGET_AWS_URL로 변경할 수 있다. 명시적인 127.0.0.1 포트만 허용한다. Azure/GCP의 팀 배포 API는 각각 9103을 제안한 상태이므로 담당자와 서로 다른 포트를 정해야 한다. 이 변경은 해당 미병합 배포 모듈을 합치지 않는다. HTTPS 자체의 Azure/GCP 어댑터는 설정에 등록된 기존 리소스를 직접 관리하며 팀 배포 엔진 확장과는 별도다.

## 설정

[adapters.example.json](adapters.example.json)은 여섯 가지 어댑터의 입력 예시다. **실제 사용하는 엔드포인트만** config.json에 복사한다. 예시의 계정/ARN/IP/프로젝트 이름은 작동하는 리소스가 아니다.

공통 필드:

| 필드 | 의미 |
| --- | --- |
| projectId / target / kind | 엔진 프로젝트와 배포 대상, HTTPS 공급자 |
| originUrl | 등록된 기존 공개 진입점 또는 로컬 프록시의 원본 주소 |
| deploymentOrigin | 대상 API가 반환하는 원본 주소가 originUrl과 다를 때 명시적으로 등록. 일치하지 않는 새 URL은 자동 신뢰하지 않음 |
| internalTransport | 운영자가 확인한 내부 구간 http/https. 미지정은 unverified이며 공개 HTTPS만으로 내부 TLS까지 성공했다고 표시하지 않음 |
| healthPath | HTTPS에서 쿠키 없이 200을 반환해야 하는 경로 |
| statePath | SQLite 상태 저장 파일 |

한 프로젝트/대상에 도메인 하나를 지원한다. 같은 요청은 동일 binding_id를 반환한다. 다른 도메인으로 바꾸려는 요청은 409다. 도메인 교체·연결 삭제 UI는 이번 범위 밖이다. 운영자는 이전 연결을 검토·정리한 뒤 별도 프로젝트/기반 리소스로 연결한다. 상태 DB만 지워 변경 이력을 잃는 방식은 사용하지 않는다.

한 공개 진입점은 한 프로젝트 전용이어야 한다. 기존 인증서·443 리스너·동일 도메인 바인딩을 덮어쓰지 않는다. 운영 중인 다른 앱과 공유하는 LB/Caddy 인스턴스는 지원하지 않는다.

### AWS ALB

- 준비된 공개 ALB, 전용 HTTP 80 리스너, 앱 Target Group, ALB 보안그룹, 계정/리전 일치가 필요하다.
- 첫 앱 배포와 HTTP 헬스체크가 성공한 뒤 HTTPS 연결을 시작한다. DNS 대기 중 앱을 재배포·중지하면 부분 HTTPS 설정을 복원하고 확인 필요 상태로 둔다. 앱을 준비한 뒤 재확인한다. HTTPS 설정과 앱 배포를 동시에 변경하지 않는다.
- ACM DNS 인증서와 인증용 CNAME을 만들고 443 리스너에 연결한다. TLS 1.2/1.3 정책을 사용한다.
- HTTP 리스너의 기본 동작 또는 명시적인 gateRuleArn을 사용한다. 규칙 방식에서는 우선순위 1의 전체 IPv4/IPv6 source-ip 게이트만 허용한다. 기본 forward는 ECS의 ALB 대상 그룹 연결을 유지하고, HTTP 리다이렉트·차단은 게이트 규칙에서 제어한다. 다른 라우팅 규칙이 있는 리스너는 거절한다.
- ALB 443 인바운드를 추가할 때 연결 ID로 생성한 규칙만 기록·복원한다.
- 전용 CLI profile만 사용한다. default와 pokeclip은 거절한다.
- 필요한 범주: STS GetCallerIdentity, ACM RequestCertificate/DescribeCertificate, ELB DescribeLoadBalancers/DescribeListeners/DescribeRules/DescribeTags/CreateListener/AddTags/ModifyListener/ModifyRule/DeleteListener, EC2 DescribeSecurityGroupRules/AuthorizeSecurityGroupIngress/RevokeSecurityGroupIngress. 계정·리전·관련 ARN으로 권한을 제한한다.
- **필수 연동:** AWS Target 설정에도 httpsControlUrl=http://127.0.0.1:9301을 지정한다. 규칙 방식이면 두 설정의 gateRuleArn이 같아야 한다. 배포·중지에서 HTTPS 게이트를 호출하고 80/443 차단을 확인한다.
- HTTPS를 켠 후에는 엔진·AWS Target·HTTPS 서비스를 함께 실행한다. 제어 서비스 장애 시 새 배포는 실패 처리하고 HTTP는 닫는다. 443 차단까지 확인되지 않으면 정리가 완료됐다고 기록하지 않는다. 실제 배포 환경에서 장애 복구 절차와 IAM을 추가 확인해야 한다.

### Azure Container Apps / App Service

- Container Apps가 팀 연동의 기본이다. 실행 중인 공개 ingress와 등록한 managed environment가 필요하다.
- 프록시하지 않은 CNAME을 서비스 기본 도메인으로 연결하고 안내된 asuid TXT를 추가한다. CAA가 있다면 공급자의 인증서 발급 조건도 충족해야 한다.
- Container Apps는 hostname Disabled 등록 → 관리형 인증서 발급 → SniEnabled 바인딩 → allowInsecure=false 순서다.
- App Service는 지원 요금제(Basic 이상 등)의 기존 앱과 기본 호스트, serverFarmId를 조회하여 무료 관리형 인증서를 생성·SNI 연결하고 httpsOnly=true를 설정한다.
- az에 등록된 subscriptionId/tenantId를 확인한다. 토큰은 호출 시 읽고 응답·SQLite에 저장하지 않는다.
- 앱 조회/수정, 사용자 도메인 바인딩, managed environment certificate 또는 Microsoft.Web certificate 생성/조회 권한이 필요하다. App Service 플랜 조회 권한도 필요하다.
- 다른 도메인은 유지한다. HTTPS-only는 Azure 앱 전체 속성이므로 프로젝트 전용 앱이어야 한다. 발급 실패 시 이번 hostname과 변경한 HTTPS-only 속성만 복원한다.

### GCP Cloud Run + 기존 외부 Application Load Balancer

Cloud Run 기본 run.app 주소는 사용자 도메인 연결 완료가 아니다. 외부 **글로벌 EXTERNAL_MANAGED** LB의 고정 IP, 기존 targetHttpProxy, URL map이 필요하다. Cloud Run/serverless NEG/backend service 연결은 배포 모듈에서 준비한다. 연결 정보가 없으면 422 RESOURCE_REQUIRED를 반환한다.

gcloud의 전용 configuration/account/project를 명시한다. Certificate Manager DNS authorization와 인증서/맵/엔트리, TLS 1.2 이상 정책, 기존 URL map을 가리키는 HTTPS 프록시와 443 forwarding rule을 만든다. 검증 후 기존 HTTP 프록시를 새 리다이렉트 URL map에 연결한다. 원본 URL map과 백엔드는 수정하지 않는다.

필요 권한은 Certificate Manager 리소스 생성/조회, 등록된 글로벌 LB 리소스 조회, HTTPS proxy/forwarding rule/SSL policy/redirect URL map 생성·삭제, 기존 HTTP proxy의 setUrlMap이다. 프로젝트 단위의 전용 신원과 좁힌 권한을 사용한다. API 활성화와 LB 구성은 사전 준비 사항이다.

비동기 생성/삭제는 다음 폴링에서 확인한다. rollback 때 HTTP proxy 복원이 확인된 다음 자신이 만든 forwarding/proxy/map/policy만 정리한다. 인증서·DNS authorization·certificate map은 재시도/갱신을 위해 남는다.

### Cloudflare Named Tunnel

기존 **원격 관리** Named Tunnel과 활성 Cloudflare 영역이 필요하다. 영역 바로 아래 한 단계 서브도메인을 사용한다. 토큰은 tokenEnv에 지정한 환경변수로만 전달한다.

사용자는 CNAME → tunnel-id.cfargotunnel.com을 등록하고 프록시를 켠다. 프록시된 CNAME은 공개 DNS에서 숨겨지므로 read-only DNS API로 정확한 레코드를 확인한다. 활성 edge 인증서가 도메인을 포함해야 한다. 기존 ingress와 다른 리다이렉트 규칙을 보존하고 hostname에 한정된 규칙만 추가한다.

토큰에는 해당 계정의 Tunnel 설정 읽기/쓰기와 해당 영역의 Zone/DNS 읽기, SSL certificate pack 읽기, Dynamic Redirect 규칙 읽기/쓰기 권한이 필요하다. DNS 쓰기는 사용하지 않는다. 플랜·토큰별 API 접근 가능 여부는 실제 환경에서 확인해야 한다. 운영자가 외부에서 같은 hostname의 경로를 바꾸면 자동 복원 대신 충돌을 표시한다.

### Caddy 직접 연결

앱 설정이 없는 전용 Caddy 인스턴스와 127.0.0.1로 제한한 Admin API, 영속 인증서 저장소, 외부에서 접근 가능한 공인 IPv4/80/443이 필요하다. CGNAT 환경에서는 직접 연결 대신 Tunnel을 선택한다.

~~~json
{
  "admin": {"listen": "127.0.0.1:2019"},
  "storage": {"module": "file_system", "root": "/persistent/shakedown-caddy"}
}
~~~

위처럼 기존 프록시가 없는 상태에서 Caddy를 실행하고 adminUrl을 등록한다. 모듈은 호스트별 reverse proxy와 ACME 자동 발급/갱신 설정을 로드한다. 인증서 확인 전에는 자동 리다이렉트를 끄고, 검증 후 80 리다이렉트를 추가한다. Caddy가 돌아가는 호스트에서 originUrl에 접근할 수 있어야 한다. 컨테이너에서 localhost가 가리키는 대상이 다른 점을 확인한다. 실패 시 이전 설정을 복원하며 인증서 저장소는 삭제하지 않는다.

## API 및 상태

계약: [https.openapi.yaml](../../packages/contracts/https.openapi.yaml).

- POST /projects/{id}/targets/{target}/https → 202
- GET /projects/{id}/targets/{target}/https → 200/404
- POST /projects/{id}/targets/{target}/https/recheck → 202
- 엔진 공개 경로는 동일 경로 앞에 /api를 붙인다.
- Target 전용 내부 경로: POST /projects/{id}/targets/aws/https/gate, body {"open":false}. 대시보드에는 이 경로를 프록시하지 않는다.

상태: preflight → dns_pending → certificate_pending → applying → verifying → ready. 24시간 미완료는 needs_action, 적용 오류는 failed다. 30초마다 재확인하며 하루 제한은 앱 배포 타임아웃과 독립적이다. 재확인 시 대기 기간을 갱신한다.

SQLite는 의도와 적용 결과를 변경 전후 저장한다. 중복 변경을 직렬화하고 SQLite process lock으로 같은 파일을 사용하는 여러 프로세스를 막는다. 설정 파일에서 연결이 삭제/변경되면 자동 변경을 중단한다. HTTPS 서비스의 여러 머신 복제 실행은 지원하지 않는다.

실패하면 자신이 만든 리스너/라우팅을 복원한다. 복원 실패는 ROLLBACK_PENDING으로 표시하고 잠금을 유지한다. 인증서와 DNS 인증 리소스는 남겨 두며 운영자가 사용 여부를 확인한 뒤 정리한다. 재시작 중 끊긴 AWS gate 열기는 자동 재개하지 않고 우선 닫는다.

ready 이후에는 주기적으로 인증서와 접속을 확인한다. 갱신 실패는 needs_action으로 표시하며 HTTP로 낮추지 않는다. 차단된 AWS 앱은 TLS 구성 상태와 traffic_blocked를 별도로 반환한다.

## 검증 경계

- Node TLS 기본 신뢰 체인, SNI/hostname, 만료일, 쿠키 없는 health 200을 확인한다. rejectUnauthorized=false를 사용하지 않는다.
- DNS가 비공개·예약 IP를 가리키면 검사하지 않는다. 조회한 공개 IP로 연결을 고정해 DNS 재조회에 따른 우회도 막는다.
- HTTPS 검증 후에만 리다이렉트한다. 별도 경로와 쿼리로 정확한 canonical HTTPS 주소 보존을 검사한다.
- 사용자→공개 진입점 암호화만 제공한다. 내부 HTTP를 별도 표시하며 앱 쿠키 Secure, 혼합 콘텐츠, DB TLS, 서비스 간 mTLS, 운영 인증/인가는 자동 해결 범위가 아니다.
- HSTS와 소스코드 자동 수정은 적용하지 않는다.
- 엔진은 프로젝트/대상/원본 주소가 일치하고 ready/유효한 인증서 결과를 가진 주소만 자동 시운전에 사용한다. 기존 비교 URL 기능의 별도 보안 정책은 유지한다.

## 검사 실행

~~~sh
npm run check:https
npm run test:https
npm run check:aws
npm run test:aws
apps/engine/.venv/bin/python -m pytest apps/engine/tests -q
npm run build:web

# 별도 설치한 공식 바이너리로 로컬 Caddy 실증(공개 인증서 발급 없음)
CADDY_BINARY=/absolute/path/to/caddy node --import tsx infra/https/test/caddy-smoke.ts
~~~

TLS 테스트는 임시 CA를 테스트 연결에만 신뢰시킨다. Caddy 실증은 생성한 ACME 설정을 실제 parser로 검증하고, 내부 CA·임시 loopback 포트로 HTTPS/리다이렉트/복원을 실행한다. **실제 공개 ACME 발급이나 클라우드 성공을 뜻하지 않는다.**

이번 실행 결과와 팀 연동 체크리스트: [검증 기록](../../docs/https-validation.md).

## 공식 참고 자료

- [AWS HTTPS listener](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html), [ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
- [Azure Container Apps managed certificate](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates), [App Service certificate](https://learn.microsoft.com/en-us/azure/app-service/configure-ssl-certificate)
- [GCP Certificate Manager DNS authorization](https://docs.cloud.google.com/certificate-manager/docs/deploy-google-managed-dns-auth)
- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/), [Redirect Rules API](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy API](https://caddyserver.com/docs/api)
