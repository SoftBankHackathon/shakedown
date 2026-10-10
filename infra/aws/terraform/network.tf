locals {
  region     = "ap-northeast-2"
  mongo      = var.create_database && var.database_engine == "mongodb"
  create_rds = var.create_database && !local.mongo
  mysql      = var.database_engine == "mysql"
  db_port    = local.mysql ? 3306 : 5432
  azs        = slice(data.aws_availability_zones.this.names, 0, 3)
}

# CFN GetAZs ""와 같은 순서(이름순 a, b, c). opt-in이 필요 없는 영역만.
data "aws_availability_zones" "this" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

resource "aws_vpc" "this" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

# 앱(Fargate)은 공인 IP로 ECR·로그에 나간다. NAT Gateway는 만들지 않는다.
resource "aws_subnet" "public" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  cidr_block        = "10.42.${count.index}.0/24"
  availability_zone = local.azs[count.index]
}

# RDS는 인터넷 경로가 없는 서브넷에 둔다.
resource "aws_subnet" "private" {
  count             = local.create_rds ? 2 : 0
  vpc_id            = aws_vpc.this.id
  cidr_block        = "10.42.${10 + count.index}.0/24"
  availability_zone = local.azs[count.index]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = 3
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---- 보안 그룹 ----
# 규칙은 모두 별도 리소스로 둔다. infra/https가 AlbSg에 443 규칙을 붙였다 떼므로 인라인 ingress를 쓰면 다음 apply가 지운다.
# Terraform은 AWS 기본 egress(전체 허용)를 지우므로 CFN과 같게 egress를 명시한다. 빠뜨리면 ECR·로그·Secrets 접근이 막힌다.
resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Public demo HTTP entry"
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "app" {
  name_prefix = "${var.name}-app-"
  description = "App ingress only from ALB; outbound for ECR logs and DB"
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "db" {
  count       = local.create_rds ? 1 : 0
  name_prefix = "${var.name}-db-"
  description = "Database only from ECS tasks"
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  count                        = local.create_rds ? 1 : 0
  security_group_id            = aws_security_group.db[0].id
  ip_protocol                  = "tcp"
  from_port                    = local.db_port
  to_port                      = local.db_port
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_egress_rule" "all" {
  for_each = merge({ alb = aws_security_group.alb.id, app = aws_security_group.app.id },
    local.create_rds ? { db = aws_security_group.db[0].id } : {},
  local.mongo ? { mongo = aws_security_group.mongo[0].id } : {})
  security_group_id = each.value
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
