# ---- TLS MongoDB 복제 세트: EC2 3대 (CFN MongoInstance 1~3과 같은 구성) ----
# 부트스트랩은 CFN과 같은 scripts/mongodb-node.sh를 고치지 않고 쓴다 (render-mongo.mjs·테스트가 YAML과 같은지 확인한다).
# CFN 치환값만 바꿔 넣고, WaitCondition 신호 줄은 지운다. 준비 대기는 래퍼가 DbUrlSecret을 보고 한다 (scripts/terraform.sh).
locals {
  mongo_count = local.mongo ? 3 : 0
  mongo_hosts = [for i in range(3) : "10.42.${i}.50"]
  # CFN WaitCondition 핸들로 신호를 보내는 줄. Terraform에는 핸들이 없고 set -e라 그대로 두면 스크립트가 실패로 끝난다.
  mongo_ready_signal = "    curl --fail --silent --show-error -X PUT -H 'Content-Type:' --data-binary '{\"Status\":\"SUCCESS\",\"Reason\":\"TLS replica set ready\",\"UniqueId\":\"mongo\",\"Data\":\"ready\"}' \"$ready_handle\"\n"
  mongo_source       = file("${path.module}/../scripts/mongodb-node.sh")
  # 노드와 상관없는 치환을 먼저 한 번 한다. Terraform에는 fold가 없어 replace를 겹쳐 쓴다.
  # (templatefile은 못 쓴다: CFN 문법 $${AWS::Region}을 템플릿 식으로 읽는다.)
  mongo_shared = local.mongo ? replace(replace(replace(replace(replace(replace(replace(
    local.mongo_source,
    local.mongo_ready_signal, "    # Terraform: 준비 대기는 래퍼가 DbUrlSecret으로 확인한다 (CFN WaitCondition 대신).\n"),
    "ready_handle='$${MongoReadyHandle}'\n", ""),
    "$${AWS::Region}", local.region),
    "$${MongoClusterSecret}", aws_secretsmanager_secret.mongo["cluster"].arn),
    "$${MongoCaSecret}", aws_secretsmanager_secret.mongo["ca"].arn),
    "$${DbSecret}", aws_secretsmanager_secret.db_password[0].arn),
  "$${DbUrlSecret}", aws_secretsmanager_secret.db_url[0].arn) : ""
  mongo_user_data = [for i in range(local.mongo_count) :
  replace(replace(replace(local.mongo_shared, "$${DatabaseName}", var.db_name), "@@INDEX@@", tostring(i)), "@@VOLUME@@", aws_ebs_volume.mongo[i].id)]
}

data "aws_ssm_parameter" "mongo_ami" {
  count = local.mongo ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_security_group" "mongo" {
  count       = local.mongo ? 1 : 0
  name_prefix = "${var.name}-mongo-"
  description = "MongoDB reachable only from application tasks; no SSH"
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "mongo_from_app" {
  count                        = local.mongo ? 1 : 0
  security_group_id            = aws_security_group.mongo[0].id
  ip_protocol                  = "tcp"
  from_port                    = 27017
  to_port                      = 27017
  referenced_security_group_id = aws_security_group.app.id
}

# 복제 세트 멤버끼리 (CFN MongoPeerIngress)
resource "aws_vpc_security_group_ingress_rule" "mongo_peer" {
  count                        = local.mongo ? 1 : 0
  security_group_id            = aws_security_group.mongo[0].id
  ip_protocol                  = "tcp"
  from_port                    = 27017
  to_port                      = 27017
  referenced_security_group_id = aws_security_group.mongo[0].id
}

# 부트스트랩이 만든 TLS 번들·CA를 담는다. 초기 {}만 Terraform이 쓰고 실제 값은 서버가 쓴다.
resource "aws_secretsmanager_secret" "mongo" {
  for_each = local.mongo ? {
    cluster = "Mongo TLS leaf/keyfile/admin bootstrap bundle; EC2 role only"
    ca      = "Public Mongo CA certificate for app trust"
  } : {}
  name_prefix = "${var.name}-mongo-${each.key}-"
  description = each.value
}

resource "aws_secretsmanager_secret_version" "mongo" {
  for_each      = aws_secretsmanager_secret.mongo
  secret_id     = each.value.id
  secret_string = "{}"
  lifecycle {
    ignore_changes = [secret_string, version_stages]
  }
}

data "aws_iam_policy_document" "mongo" {
  count = local.mongo ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db_password[0].arn, aws_secretsmanager_secret.mongo["cluster"].arn]
  }
  statement {
    actions   = ["secretsmanager:PutSecretValue"]
    resources = [aws_secretsmanager_secret.db_url[0].arn, aws_secretsmanager_secret.mongo["cluster"].arn, aws_secretsmanager_secret.mongo["ca"].arn]
  }
}

resource "aws_iam_role" "mongo" {
  count              = local.mongo ? 1 : 0
  name_prefix        = "${var.name}-mongo-"
  assume_role_policy = data.aws_iam_policy_document.assume["ec2"].json
}

resource "aws_iam_role_policy_attachment" "mongo_ssm" {
  count      = local.mongo ? 1 : 0
  role       = aws_iam_role.mongo[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "mongo" {
  count  = local.mongo ? 1 : 0
  name   = "read-own-db-password"
  role   = aws_iam_role.mongo[0].id
  policy = data.aws_iam_policy_document.mongo[0].json
}

resource "aws_iam_instance_profile" "mongo" {
  count       = local.mongo ? 1 : 0
  name_prefix = "${var.name}-mongo-"
  role        = aws_iam_role.mongo[0].name
}

# CFN DeletionPolicy: Snapshot → destroy 때 최종 스냅샷
resource "aws_ebs_volume" "mongo" {
  count             = local.mongo_count
  availability_zone = aws_subnet.public[count.index].availability_zone
  size              = 20
  type              = "gp3"
  encrypted         = true
  final_snapshot    = true
  tags              = { Name = "${var.name}-mongo-data-${count.index}", ShakedownMongoBackup = var.name }
}

resource "aws_instance" "mongo" {
  count                       = local.mongo_count
  ami                         = data.aws_ssm_parameter.mongo_ami[0].insecure_value
  instance_type               = "t3.small"
  iam_instance_profile        = aws_iam_instance_profile.mongo[0].name
  subnet_id                   = aws_subnet.public[count.index].id
  associate_public_ip_address = true
  private_ip                  = local.mongo_hosts[count.index]
  vpc_security_group_ids      = [aws_security_group.mongo[0].id]
  user_data                   = local.mongo_user_data[count.index]
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size           = 12
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }
  tags = { Name = "${var.name}-mongo-${count.index}" }
  lifecycle {
    # SSM AMI가 갱신되면 3대가 한꺼번에 교체된다. 부트스트랩 수정도 교체 사유로 삼지 않는다 (명세 1.6).
    ignore_changes = [ami, user_data]
    precondition {
      condition     = strcontains(local.mongo_source, local.mongo_ready_signal) && !strcontains(local.mongo_user_data[count.index], "$${")
      error_message = "scripts/mongodb-node.sh가 바뀌어 CFN 치환값이나 WaitCondition 신호 줄을 찾지 못했습니다. mongo.tf의 치환 목록을 맞추세요."
    }
  }
  # dnf·docker pull에 인터넷이 필요하다 (CFN DependsOn PublicRoute, RouteX). 비밀 초기 버전이 있어야 부트스트랩이 읽는다.
  depends_on = [aws_route.internet, aws_route_table_association.public, aws_iam_role_policy.mongo,
  aws_secretsmanager_secret_version.mongo, aws_secretsmanager_secret_version.db_password, aws_secretsmanager_secret_version.db_url]
}

resource "aws_volume_attachment" "mongo" {
  count       = local.mongo_count
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.mongo[count.index].id
  instance_id = aws_instance.mongo[count.index].id
}

# ---- 일일 스냅샷 (선택) ----
resource "aws_iam_role" "mongo_snapshot" {
  count              = local.mongo && var.enable_mongo_snapshots ? 1 : 0
  name_prefix        = "${var.name}-dlm-"
  assume_role_policy = data.aws_iam_policy_document.assume["dlm"].json
}

resource "aws_iam_role_policy_attachment" "mongo_snapshot" {
  count      = length(aws_iam_role.mongo_snapshot)
  role       = aws_iam_role.mongo_snapshot[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "mongo" {
  count              = length(aws_iam_role.mongo_snapshot)
  description        = "Daily Mongo EBS crash-consistent snapshots retain seven"
  execution_role_arn = aws_iam_role.mongo_snapshot[0].arn
  state              = "ENABLED"
  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { ShakedownMongoBackup = var.name }
    schedule {
      name      = "daily"
      copy_tags = true
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["18:00"]
      }
      retain_rule {
        count = 7
      }
    }
  }
}
