# ---- DB 비밀 ----
# CFN은 Secrets Manager가 비밀번호를 만들어 상태에 평문이 없었다. Terraform은 random_password라 상태에 들어간다 (Azure·GCP와 같은 방식, .data에 700 권한).
# CFN과 같은 모양 {"username":"board_admin","password":"..."}. RDS가 금지하는 / @ " 공백과 \ 는 쓰지 않는다.
resource "random_password" "db" {
  count            = var.create_database ? 1 : 0
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "db_password" {
  count       = var.create_database ? 1 : 0
  name_prefix = "${var.name}-db-password-"
  description = "DB password read only for managed URL synchronization"
}

resource "aws_secretsmanager_secret_version" "db_password" {
  count         = var.create_database ? 1 : 0
  secret_id     = aws_secretsmanager_secret.db_password[0].id
  secret_string = jsonencode({ username = "board_admin", password = random_password.db[0].result })
}

# 어댑터가 배포마다 접속 URL을 써 넣는다 (database-url.ts:26). 초기 버전 {}가 반드시 있어야 GetSecretValue가 실패하지 않는다.
resource "aws_secretsmanager_secret" "db_url" {
  count       = var.create_database ? 1 : 0
  name_prefix = "${var.name}-db-url-"
  description = "Database URL refreshed by the adapter on deployment"
}

resource "aws_secretsmanager_secret_version" "db_url" {
  count         = var.create_database ? 1 : 0
  secret_id     = aws_secretsmanager_secret.db_url[0].id
  secret_string = "{}"
  lifecycle {
    ignore_changes = [secret_string, version_stages]
  }
}

# ---- RDS PostgreSQL / MySQL ----
# provision.sh의 describe-orderable-db-instance-options와 같다. 서울 db.t3.micro에 없는 버전이면 plan에서 실패한다.
data "aws_rds_orderable_db_instance" "this" {
  count          = local.create_rds ? 1 : 0
  engine         = var.database_engine
  engine_version = local.mysql ? var.mysql_version : var.postgres_version
  instance_class = "db.t3.micro"
}

resource "aws_db_subnet_group" "this" {
  count       = local.create_rds ? 1 : 0
  name_prefix = "${var.name}-"
  description = "Isolated subnets without an internet route"
  subnet_ids  = aws_subnet.private[*].id
}

resource "aws_db_instance" "this" {
  count                      = local.create_rds ? 1 : 0
  identifier                 = "${var.name}-db"
  engine                     = var.database_engine
  engine_version             = data.aws_rds_orderable_db_instance.this[0].engine_version
  instance_class             = "db.t3.micro"
  allocated_storage          = 20
  storage_type               = "gp3"
  storage_encrypted          = true
  publicly_accessible        = false
  db_name                    = var.db_name
  username                   = "board_admin"
  password                   = random_password.db[0].result
  db_subnet_group_name       = aws_db_subnet_group.this[0].name
  vpc_security_group_ids     = [aws_security_group.db[0].id]
  backup_retention_period    = 1
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true
  # CFN DeletionPolicy: Snapshot. 이름이 고정이라 같은 스택을 두 번 destroy하면 스냅샷 이름이 겹친다 → 앞의 스냅샷을 지우거나 이름을 바꾼다.
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name}-db-final"
  apply_immediately         = true
  lifecycle {
    precondition {
      condition     = local.mysql || var.postgres_version != null
      error_message = "postgres는 postgres_version(17.x)을 지정해야 합니다 (CFN PostgresVersion에 기본값이 없음)."
    }
    # MultiAZ는 어댑터가 아키텍처 등급에 따라 바꾼다 (aws-provider.ts:248). 엔진 버전은 자동 마이너 업그레이드 뒤 되돌리지 않는다.
    ignore_changes = [multi_az, engine_version]
  }
}
