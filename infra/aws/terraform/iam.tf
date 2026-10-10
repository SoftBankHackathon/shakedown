locals {
  # 리전이 서울 고정이라 partition은 aws다. 계정은 provider의 allowed_account_ids가 var.account_id로 강제한다.
  partition = "aws"
  account   = var.account_id
  # 앱(실행 역할)과 어댑터가 읽는 DB 비밀. Mongo면 CA 인증서도 (CFN은 WithMongo 조건 statement를 따로 뒀다).
  db_secrets = var.create_database ? concat([aws_secretsmanager_secret.db_password[0].arn, aws_secretsmanager_secret.db_url[0].arn],
  local.mongo ? [aws_secretsmanager_secret.mongo["ca"].arn] : []) : []
}

# 역할마다 신뢰 주체(서비스)만 다르다: ECS 태스크, Mongo EC2, 스냅샷(DLM).
data "aws_iam_policy_document" "assume" {
  for_each = toset(["ecs-tasks", "ec2", "dlm"])
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["${each.key}.amazonaws.com"]
    }
  }
}

# ---- 태스크 실행 역할: 이미지 pull, 로그, DB·외부 비밀 읽기 ----
data "aws_iam_policy_document" "execution" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.this.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
  dynamic "statement" {
    for_each = var.create_database ? [1] : []
    content {
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.db_secrets
    }
  }
  dynamic "statement" {
    for_each = length(var.additional_secrets) > 0 ? [1] : []
    content {
      actions   = ["secretsmanager:GetSecretValue"]
      resources = values(var.additional_secrets)
    }
  }
  dynamic "statement" {
    for_each = length(var.additional_kms_key_arns) > 0 ? [1] : []
    content {
      actions   = ["kms:Decrypt"]
      resources = var.additional_kms_key_arns
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${local.region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name}-exec-"
  assume_role_policy = data.aws_iam_policy_document.assume["ecs-tasks"].json
}

resource "aws_iam_role_policy" "execution" {
  name   = "image-logs-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# 앱 자신은 AWS API를 부르지 않는다. 권한 없는 역할.
resource "aws_iam_role" "task" {
  name_prefix        = "${var.name}-task-"
  assume_role_policy = data.aws_iam_policy_document.assume["ecs-tasks"].json
}

# ---- 어댑터 정책: 붙이지 않고 ARN만 출력한다. 운영자가 어댑터 principal에 붙인다 (README) ----
data "aws_iam_policy_document" "adapter" {
  statement {
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:DescribeServices", "ecs:ListTasks", "ecs:DescribeTasks"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:service/${aws_ecs_cluster.this.name}/${var.name}"]
  }
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:task-definition/${var.name}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    actions   = ["ecs:StopTask"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:task/${aws_ecs_cluster.this.name}/*"]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:${local.partition}:iam::${local.account}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["ecs.amazonaws.com"]
    }
  }
  statement {
    actions   = ["elasticloadbalancing:ModifyRule"]
    resources = [aws_lb_listener_rule.gate.arn]
  }
  statement {
    actions   = ["elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes"]
    resources = [aws_lb_target_group.this.arn]
  }
  statement {
    actions   = ["elasticloadbalancing:DescribeTargetHealth"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:DescribeImages"]
    resources = [aws_ecr_repository.this.arn]
  }
  dynamic "statement" {
    for_each = var.create_database ? [1] : []
    content {
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.db_secrets
    }
  }
  dynamic "statement" {
    for_each = var.create_database ? [1] : []
    content {
      actions   = ["secretsmanager:PutSecretValue"]
      resources = [aws_secretsmanager_secret.db_url[0].arn]
    }
  }
  statement {
    actions   = ["logs:DescribeLogStreams", "logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
  statement {
    # ec2:DescribeInstances는 CFN AdapterPolicy에 없지만 Mongo 상태 확인(aws-provider.ts:225)이 부른다 (명세 1.9).
    actions   = ["ec2:DescribeSubnets", "ec2:DescribeInstances", "rds:DescribeDBInstances", "application-autoscaling:DescribeScalableTargets"]
    resources = ["*"]
  }
  dynamic "statement" {
    for_each = local.create_rds ? [1] : []
    content {
      actions   = ["rds:ModifyDBInstance"]
      resources = [aws_db_instance.this[0].arn]
    }
  }
  statement {
    actions   = ["application-autoscaling:RegisterScalableTarget", "application-autoscaling:DeregisterScalableTarget", "application-autoscaling:PutScalingPolicy"]
    resources = ["arn:${local.partition}:application-autoscaling:${local.region}:${local.account}:scalable-target/*"]
    condition {
      test     = "StringEquals"
      variable = "application-autoscaling:service-namespace"
      values   = ["ecs"]
    }
    condition {
      test     = "StringEquals"
      variable = "application-autoscaling:scalable-dimension"
      values   = ["ecs:service:DesiredCount"]
    }
  }
  statement {
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:${local.partition}:iam::${local.account}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["ecs.application-autoscaling.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "adapter" {
  name_prefix = "${var.name}-adapter-"
  description = "Attach to the chosen adapter principal; DB secret access for URL synchronization"
  policy      = data.aws_iam_policy_document.adapter.json
}

data "aws_iam_policy_document" "image_publisher" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
    "ecr:PutImage", "ecr:DescribeImages", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.this.arn]
  }
}

resource "aws_iam_policy" "image_publisher" {
  name_prefix = "${var.name}-publisher-"
  description = "Separate build/push permissions for the engine or CI"
  policy      = data.aws_iam_policy_document.image_publisher.json
}
