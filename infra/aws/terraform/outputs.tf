# 어댑터 설정 (src/config.ts configSchema와 같은 키, .strict()). 비밀값은 없고 Secret ARN만 있다.
# config-from-outputs.ts와 같은 규칙: DB가 없으면 db* 키를 넣지 않는다. 선택 키는 아예 뺀다(스키마가 null을 거부). 조건부 묶음은 null로 두면 merge가 건너뛴다.
locals {
  adapter_config = merge(
    {
      profile          = var.profile
      accountId        = var.account_id
      region           = local.region
      projectId        = var.project_id
      port             = var.app_port
      clusterArn       = aws_ecs_cluster.this.arn
      repository       = aws_ecr_repository.this.name
      repositoryUri    = aws_ecr_repository.this.repository_url
      serviceName      = var.name
      listenerArn      = aws_lb_listener.http.arn
      gateRuleArn      = aws_lb_listener_rule.gate.arn
      targetGroupArn   = aws_lb_target_group.this.arn
      publicUrl        = "http://${aws_lb.this.dns_name}"
      subnetIds        = aws_subnet.public[*].id
      securityGroupId  = aws_security_group.app.id
      executionRoleArn = aws_iam_role.execution.arn
      taskRoleArn      = aws_iam_role.task.arn
      logGroup         = aws_cloudwatch_log_group.this.name
      secrets          = var.additional_secrets
    },
    local.create_rds ? {
      dbEngine     = var.database_engine
      dbInstanceId = aws_db_instance.this[0].identifier
      # .endpoint는 host:port라 쓰면 안 된다.
      dbHost     = aws_db_instance.this[0].address
      dbUsername = "board_admin"
    } : null,
    local.mongo ? {
      dbEngine      = "mongodb"
      dbInstanceId  = aws_instance.mongo[0].id
      dbHost        = aws_instance.mongo[0].private_ip
      dbUsername    = "app"
      dbHosts       = local.mongo_hosts
      dbInstanceIds = aws_instance.mongo[*].id
      dbCaSecretArn = aws_secretsmanager_secret.mongo["ca"].arn
    } : null,
    var.create_database ? {
      dbName              = var.db_name
      dbPasswordSecretArn = aws_secretsmanager_secret.db_password[0].arn
      dbUrlSecretArn      = aws_secretsmanager_secret.db_url[0].arn
    } : null,
    var.https_control_url == null ? null : { httpsControlUrl = var.https_control_url },
  )
}

resource "local_file" "adapter_config" {
  filename        = var.config_path
  content         = "${jsonencode(local.adapter_config)}\n"
  file_permission = "0600"
  depends_on      = [aws_secretsmanager_secret_version.db_password, aws_secretsmanager_secret_version.db_url, aws_iam_role_policy.execution]
}

output "adapter_config" {
  value = local.adapter_config
}

# 래퍼가 Mongo 준비(WaitCondition 대신)를 기다릴 때 읽는다.
output "db_url_secret_arn" {
  value = var.create_database ? aws_secretsmanager_secret.db_url[0].arn : ""
}

# 어댑터·이미지 게시 principal에 운영자가 붙인다 (설정 파일에는 들어가지 않는다).
output "adapter_policy_arn" {
  value = aws_iam_policy.adapter.arn
}

output "image_publisher_policy_arn" {
  value = aws_iam_policy.image_publisher.arn
}
