# 온프레미스 호스트 (AWS EC2로 흉내)

온프레미스 배포 대상은 별도 어댑터가 아니라 **로컬 어댑터(`infra/local`)의 direct 모드**를 리눅스 서버 한 대에서 돌리는 구조다(#31). 이 폴더는 그 서버를 AWS EC2로 다시 만들 수 있게 한 Terraform이다. 2026-10-10 실측(`docs/experiments/2026-10-10-onprem-ec2.md`, `...-direct-deployment-reboot.md`)과 같은 조건이고, 설계 근거는 `docs/terraform-migration-aws-gcp.md` 3절에 있다.

```sh
export HACKATHON_PROVISION_PROFILE=<profile> HACKATHON_ACCOUNT_ID=<12자리>
ONPREM_ALLOWED_CIDRS=<데모장 IP>/32 bash infra/onprem/scripts/terraform.sh apply
bash infra/onprem/scripts/terraform.sh check     # 몇 분 뒤: 설치 완료 + 127.0.0.1:9101/health
bash infra/onprem/scripts/terraform.sh update    # 커밋한 infra/local 변경을 서버에 반영 (첫 부팅과 같은 설치 스크립트, systemd 유닛 포함. 서버·DB 볼륨 유지)
bash infra/onprem/scripts/terraform.sh destroy
```

## 만드는 것

- 전용 VPC 10.43.0.0/16(기반 스택 10.42와 겹치지 않음), 공인 서브넷 1개, Elastic IP(재시작해도 공개 주소 고정)
- 보안 그룹: **앱 포트(기본 18080)만** `ONPREM_ALLOWED_CIDRS`와 서버 자신의 EIP `/32`에 연다. 자기 `/32`는 공개 URL 자체 health 확인에 필요하다. SSH·DB·9101(제어 API)은 열지 않는다
- EC2 Amazon Linux 2023 t3.medium, 암호화 gp3 24GiB, IMDSv2 필수, 키 페어 없음(관리는 SSM)
- 부팅 때 무인 설치(`terraform/bootstrap.sh.tftpl`)
  - Docker는 dnf, Compose v5.6.0과 Node v22.23.2는 공식 배포본을 받아 **SHA256 확인 후** 설치
  - S3에서 코드 묶음(`infra/local` + `packages/contracts`, 커밋된 HEAD)을 받아 `/opt/shakedown`에 푼다
  - SSM SecureString에서 DB 비밀번호를 읽어 `/etc/shakedown-local.env`(root 0600)에 쓴다. **user_data에는 비밀번호가 없다**
  - systemd `shakedown-local`을 켠다
- 엔진용 설정 `.data/onprem/<이름>-engine.env`(`LOCAL_DELIVERY_MODE=direct`, `LOCAL_PUBLIC_URL`)

## 엔진 연결 (미해결, 명세 3.4)

- 제어 API는 loopback 전용이다. 개발 PC의 엔진은 `terraform.sh output`의 `port_forward_command`(SSM 포트 포워딩, session-manager-plugin 필요)로 붙는다. 9101을 공개하지 않는다.
- 이미지: 원격 서버의 Docker는 개발 PC에서 빌드한 이미지를 볼 수 없다. (a) 엔진도 이 서버에서 돌리거나, (b) `ONPREM_ECR_REPOSITORY_ARNS`로 ECR pull 권한과 자격 도우미를 넣고 엔진이 ECR digest를 넘기게 해야 한다. (b)의 엔진 쪽 변경은 아직 없다.

## 검증 상태

- `terraform validate`, 가짜 provider 시험 4개(`cd terraform && terraform init -backend=false && terraform test`), 렌더링한 부트스트랩 `bash -n` 통과
- **실제 AWS에서는 아직 돌려 보지 않았다.** 무인 설치는 실측에서도 손으로 했던 절차를 옮긴 것이다
