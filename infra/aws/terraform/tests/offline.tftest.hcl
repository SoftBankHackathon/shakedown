# 실계정 없이 도는 시험 (terraform test). AWS provider는 가짜로 바꾸고 random·local은 진짜를 쓴다.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-northeast-2a", "ap-northeast-2b", "ap-northeast-2c", "ap-northeast-2d"] }
  }
  mock_data "aws_rds_orderable_db_instance" {
    defaults = { engine_version = "17.6" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:ap-northeast-2:123456789012:cluster/shakedown-board" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/shakedown-board", arn = "arn:aws:ecr:ap-northeast-2:123456789012:repository/shakedown-board" }
  }
  mock_resource "aws_lb" {
    defaults = { dns_name = "shakedown-board-1234567890.ap-northeast-2.elb.amazonaws.com", arn = "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:loadbalancer/app/shakedown-board/1" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:listener/app/shakedown-board/1/2" }
  }
  mock_resource "aws_lb_listener_rule" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:listener-rule/app/shakedown-board/1/2/3" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:targetgroup/sdtg-1/4" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/shakedown-board-adapter-1" }
  }
  mock_resource "aws_vpc" {
    defaults = { id = "vpc-0123456789abcdef0" }
  }
  mock_resource "aws_subnet" {
    defaults = { id = "subnet-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/shakedown-board-exec-1", id = "shakedown-board-exec-1" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shakedown-board-db-AbCdEf", id = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shakedown-board-db-AbCdEf" }
  }
  mock_resource "aws_db_instance" {
    defaults = { address = "shakedown-board-db.abcdefghij.ap-northeast-2.rds.amazonaws.com", arn = "arn:aws:rds:ap-northeast-2:123456789012:db:shakedown-board-db" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-0123456789abcdef0" }
  }
  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { insecure_value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-northeast-2:123456789012:log-group:/shakedown/shakedown-board" }
  }
}

variables {
  profile          = "hackathon"
  account_id       = "123456789012"
  postgres_version = "17.6"
  config_path      = "../../../.data/aws/test/offline-postgres.json"
}

run "postgres_스택은_CFN과_같은_자원과_설정을_만든다" {
  command = apply

  assert {
    condition     = length(aws_subnet.public) == 3 && length(aws_subnet.private) == 2 && aws_subnet.private[1].cidr_block == "10.42.11.0/24"
    error_message = "서브넷 구성이 CFN(Public 3 + Private 2)과 다릅니다."
  }
  assert {
    condition     = length(aws_vpc_security_group_egress_rule.all) == 3
    error_message = "ALB·앱·DB SG 모두 egress가 있어야 합니다 (Terraform은 기본 egress를 지운다)."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_app[0].from_port == 5432
    error_message = "postgres DB 포트는 5432입니다."
  }
  assert {
    condition     = aws_db_instance.this[0].instance_class == "db.t3.micro" && aws_db_instance.this[0].storage_encrypted && !aws_db_instance.this[0].publicly_accessible && !aws_db_instance.this[0].skip_final_snapshot
    error_message = "RDS 설정이 CFN과 다릅니다."
  }
  assert {
    condition     = jsondecode(aws_secretsmanager_secret_version.db_password[0].secret_string).username == "board_admin" && length(jsondecode(aws_secretsmanager_secret_version.db_password[0].secret_string).password) == 32
    error_message = "DB 비밀은 CFN과 같은 {username, password(32자)} 모양이어야 합니다."
  }
  assert {
    condition     = aws_secretsmanager_secret_version.db_url[0].secret_string == "{}"
    error_message = "URL 비밀은 {} 초기 버전이 있어야 합니다."
  }
  assert {
    condition     = aws_lb_listener_rule.gate.action[0].type == "fixed-response" && aws_lb_listener_rule.gate.action[0].fixed_response[0].status_code == "403"
    error_message = "게이트 규칙은 처음에 403으로 막아야 합니다."
  }
  assert {
    condition = jsondecode(local_file.adapter_config.content) == {
      profile             = "hackathon"
      accountId           = "123456789012"
      region              = "ap-northeast-2"
      projectId           = "prj_board"
      port                = 8080
      clusterArn          = "arn:aws:ecs:ap-northeast-2:123456789012:cluster/shakedown-board"
      repository          = "shakedown-board"
      repositoryUri       = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/shakedown-board"
      serviceName         = "shakedown-board"
      listenerArn         = "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:listener/app/shakedown-board/1/2"
      gateRuleArn         = "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:listener-rule/app/shakedown-board/1/2/3"
      targetGroupArn      = "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:targetgroup/sdtg-1/4"
      publicUrl           = "http://shakedown-board-1234567890.ap-northeast-2.elb.amazonaws.com"
      subnetIds           = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef0", "subnet-0123456789abcdef0"]
      securityGroupId     = "sg-0123456789abcdef0"
      executionRoleArn    = "arn:aws:iam::123456789012:role/shakedown-board-exec-1"
      taskRoleArn         = "arn:aws:iam::123456789012:role/shakedown-board-exec-1"
      logGroup            = "/shakedown/shakedown-board"
      secrets             = {}
      dbEngine            = "postgres"
      dbInstanceId        = "shakedown-board-db"
      dbHost              = "shakedown-board-db.abcdefghij.ap-northeast-2.rds.amazonaws.com"
      dbName              = "board_db"
      dbUsername          = "board_admin"
      dbPasswordSecretArn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shakedown-board-db-AbCdEf"
      dbUrlSecretArn      = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shakedown-board-db-AbCdEf"
    }
    error_message = "설정 파일 키·값이 config-from-outputs.ts 결과와 다릅니다."
  }
}

run "mysql은_3306과_mysql_버전을_쓴다" {
  command = plan
  variables {
    database_engine  = "mysql"
    postgres_version = null
    config_path      = "../../../.data/aws/test/offline-mysql.json"
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_app[0].from_port == 3306 && aws_db_instance.this[0].engine == "mysql"
    error_message = "mysql 스택은 3306 포트와 mysql 엔진이어야 합니다."
  }
}

run "DB_없는_스택은_db_키와_DB_자원을_만들지_않는다" {
  command = apply
  variables {
    create_database = false
    config_path     = "../../../.data/aws/test/offline-nodb.json"
  }
  assert {
    condition     = length(aws_db_instance.this) == 0 && length(aws_subnet.private) == 0 && length(aws_vpc_security_group_egress_rule.all) == 2
    error_message = "DB 없는 스택이 DB 자원을 만듭니다."
  }
  assert {
    condition     = !contains(keys(jsondecode(local_file.adapter_config.content)), "dbHost") && !contains(keys(jsondecode(local_file.adapter_config.content)), "dbEngine")
    error_message = "DB 없는 스택 설정에 db 키가 들어 있습니다."
  }
}

run "postgres는_버전이_필수다" {
  command = plan
  variables {
    postgres_version = null
  }
  expect_failures = [aws_db_instance.this]
}

run "mongodb는_EC2_3대_TLS_복제_세트와_Mongo_설정_키를_만든다" {
  command = apply
  variables {
    database_engine  = "mongodb"
    postgres_version = null
    config_path      = "../../../.data/aws/test/offline-mongo.json"
  }
  assert {
    condition     = length(aws_instance.mongo) == 3 && length(aws_ebs_volume.mongo) == 3 && length(aws_db_instance.this) == 0 && length(aws_subnet.private) == 0
    error_message = "mongodb는 RDS 없이 EC2·EBS 3개씩이어야 합니다."
  }
  assert {
    condition     = [for i in aws_instance.mongo : i.private_ip] == ["10.42.0.50", "10.42.1.50", "10.42.2.50"] && alltrue([for v in aws_ebs_volume.mongo : v.final_snapshot && v.encrypted])
    error_message = "Mongo 고정 IP·EBS 최종 스냅샷·암호화가 CFN과 다릅니다."
  }
  assert {
    condition     = alltrue([for u in local.mongo_user_data : !strcontains(u, "$${") && !strcontains(u, "ready_handle") && strcontains(u, "vol-0123456789abcdef0")])
    error_message = "부트스트랩에 CFN 치환값이나 WaitCondition 핸들이 남아 있습니다."
  }
  assert {
    condition     = strcontains(local.mongo_user_data[0], "node_index='0'") && strcontains(local.mongo_user_data[2], "node_index='2'") && strcontains(local.mongo_user_data[0], "region='ap-northeast-2'")
    error_message = "노드 번호·리전 치환이 틀렸습니다."
  }
  assert {
    condition     = length(aws_dlm_lifecycle_policy.mongo) == 0
    error_message = "스냅샷(DLM)은 기본 꺼짐이어야 합니다 (SCP로 막힌 계정)."
  }
  assert {
    condition = { for k, v in jsondecode(local_file.adapter_config.content) : k => v if startswith(k, "db") } == {
      dbEngine            = "mongodb"
      dbInstanceId        = "i-0123456789abcdef0"
      dbHost              = "10.42.0.50"
      dbUsername          = "app"
      dbName              = "board_db"
      dbHosts             = ["10.42.0.50", "10.42.1.50", "10.42.2.50"]
      dbInstanceIds       = ["i-0123456789abcdef0", "i-0123456789abcdef0", "i-0123456789abcdef0"]
      dbCaSecretArn       = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shakedown-board-db-AbCdEf"
      dbPasswordSecretArn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shakedown-board-db-AbCdEf"
      dbUrlSecretArn      = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shakedown-board-db-AbCdEf"
    }
    error_message = "Mongo 설정 키가 CFN 출력(config-from-outputs.ts)과 다릅니다."
  }
}

run "default_프로필은_거부한다" {
  command = plan
  variables {
    profile = "default"
  }
  expect_failures = [var.profile]
}
