# 실계정 없이 도는 시험 (terraform test). AWS provider는 가짜, random·local은 진짜.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-northeast-2a", "ap-northeast-2b", "ap-northeast-2c"] }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { insecure_value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_eip" {
    defaults = { public_ip = "203.0.113.10", id = "eipalloc-0123456789abcdef0" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-0123456789abcdef0" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { id = "shakedown-onprem-bundle-1", arn = "arn:aws:s3:::shakedown-onprem-bundle-1" }
  }
  mock_resource "aws_ssm_parameter" {
    defaults = { arn = "arn:aws:ssm:ap-northeast-2:123456789012:parameter/shakedown/shakedown-onprem/local-db-password" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/shakedown-onprem-host-1", name = "shakedown-onprem-host-1", id = "shakedown-onprem-host-1" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0" }
  }
}

variables {
  profile         = "hackathon"
  account_id      = "123456789012"
  bundle_path     = "tests/fixtures/bundle.tar.gz"
  engine_env_path = "../../../.data/onprem/test/engine.env"
}

run "기본은_자기_IP만_앱_포트로_열고_SSH_DB_제어API는_열지_않는다" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_ingress_rule.self.cidr_ipv4 == "203.0.113.10/32" && aws_vpc_security_group_ingress_rule.self.from_port == 18080
    error_message = "공개 URL 자체 확인용 자기 /32 규칙이 앱 포트에 있어야 합니다."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.allowed) == 0
    error_message = "allowed_cidrs가 비면 다른 곳에는 열지 않아야 합니다."
  }
  assert {
    condition     = aws_instance.host.metadata_options[0].http_tokens == "required" && aws_instance.host.root_block_device[0].encrypted
    error_message = "IMDSv2 필수·암호화 EBS여야 합니다. (키 페어 없음은 가짜 provider가 값을 채워 시험할 수 없다. main.tf에 key_name을 두지 않는다.)"
  }
  assert {
    condition     = !strcontains(local.bootstrap, random_password.db.result)
    error_message = "user_data에 DB 비밀번호가 들어 있습니다 (EC2 API로 읽힌다)."
  }
  assert {
    condition     = strcontains(local.bootstrap, "LOCAL_PUBLIC_URL=http://203.0.113.10:18080") && strcontains(local.bootstrap, "LOCAL_DELIVERY_MODE=direct") && strcontains(local.bootstrap, "LOCAL_BIND_ADDRESS=0.0.0.0")
    error_message = "부트스트랩이 direct 모드·EIP 공개 주소를 쓰지 않습니다."
  }
  assert {
    condition     = !strcontains(local.bootstrap, "amazon-ecr-credential-helper") && !strcontains(local.bootstrap, "credHelpers")
    error_message = "ECR을 지정하지 않았는데 자격 도우미를 설치합니다."
  }
  assert {
    condition     = local_file.engine_env.content == "LOCAL_DELIVERY_MODE=direct\nLOCAL_PUBLIC_URL=http://203.0.113.10:18080\n" && strcontains(local.bootstrap, local_file.engine_env.content)
    error_message = "엔진 설정과 서버 env가 같은 direct 모드·공개 URL이 아닙니다."
  }
  assert {
    condition     = strcontains(local.bootstrap, "/usr/local/sbin/shakedown-install-bundle") && !strcontains(local.bootstrap, "169.254.169.254")
    error_message = "설치는 update와 같은 스크립트를 써야 하고, 리전은 메타데이터 조회 없이 넘겨야 합니다."
  }
  assert {
    condition     = aws_vpc.this.cidr_block == "10.43.0.0/16"
    error_message = "온프레미스 VPC는 기반 스택(10.42)과 겹치지 않아야 합니다."
  }
}

run "허용_IP와_ECR을_주면_그것만_추가한다" {
  command = apply
  variables {
    allowed_cidrs       = ["198.51.100.7/32"]
    ecr_repository_arns = ["arn:aws:ecr:ap-northeast-2:123456789012:repository/shakedown-board"]
    app_port            = 18090
    engine_env_path     = "../../../.data/onprem/test/engine-ecr.env"
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.allowed["198.51.100.7/32"].from_port == 18090
    error_message = "허용 IP 규칙이 앱 포트로 열리지 않았습니다."
  }
  assert {
    condition     = strcontains(local.bootstrap, "amazon-ecr-credential-helper") && strcontains(local.bootstrap, "\"123456789012.dkr.ecr.ap-northeast-2.amazonaws.com\":\"ecr-login\"")
    error_message = "ECR 레지스트리 자격 도우미가 설정되지 않았습니다."
  }
}

run "제어_API_포트는_앱_포트로_쓸_수_없다" {
  command = plan
  variables {
    app_port = 9101
  }
  expect_failures = [var.app_port]
}

run "default_프로필은_거부한다" {
  command = plan
  variables {
    profile = "default"
  }
  expect_failures = [var.profile]
}
