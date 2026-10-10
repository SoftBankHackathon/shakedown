locals {
  region     = "ap-northeast-2"
  public_url = "http://${aws_eip.this.public_ip}:${var.app_port}"
  bundle_uri = "s3://${aws_s3_bucket.bundle.id}/${aws_s3_object.bundle.key}"
  # 엔진과 어댑터가 반드시 같은 값을 써야 한다 (infra/local/README.md). 서버 env와 엔진용 파일이 이 한 곳에서 나온다.
  delivery_env = "LOCAL_DELIVERY_MODE=direct\nLOCAL_PUBLIC_URL=${local.public_url}\n"
  # 비밀번호는 넣지 않는다 (EC2 API로 user_data가 읽힌다). 서버가 SSM에서 읽는다.
  bootstrap = templatefile("${path.module}/bootstrap.sh.tftpl", {
    node_version    = var.node_version
    compose_version = var.compose_version
    bundle_s3_uri   = local.bundle_uri
    password_param  = aws_ssm_parameter.db_password.name
    region          = local.region
    delivery_env    = local.delivery_env
    app_port        = var.app_port
    ecr_registries  = local.ecr_registries
  })
  ecr = length(var.ecr_repository_arns) > 0
  # ECR 레지스트리 호스트 (자격 도우미 설정용)
  ecr_registries = distinct([for a in var.ecr_repository_arns : "${split(":", a)[4]}.dkr.ecr.${local.region}.amazonaws.com"])
}

data "aws_availability_zones" "this" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# ---- 격리 VPC (다이어그램의 "격리 VPC". 기반 스택 10.42와 겹치지 않게 10.43) ----
resource "aws_vpc" "this" {
  cidr_block           = "10.43.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = "10.43.0.0/24"
  availability_zone = data.aws_availability_zones.this.names[0]
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
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ---- 고정 공개 주소: stop/start해도 LOCAL_PUBLIC_URL이 바뀌지 않게 ----
resource "aws_eip" "this" {
  domain     = "vpc"
  depends_on = [aws_internet_gateway.this]
}

# ---- 보안 그룹: 앱 포트만. SSH·DB·9101(제어 API)은 열지 않는다 ----
resource "aws_security_group" "host" {
  name_prefix = "${var.name}-"
  description = "On-prem host: app port only; no SSH, DB or control API"
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

# 로컬 어댑터는 공개 URL 자체가 200을 돌려줘야 ready다. 서버가 자기 EIP로 나갔다 들어오므로 자기 /32가 필요하다 (실측과 같음).
resource "aws_vpc_security_group_ingress_rule" "self" {
  security_group_id = aws_security_group.host.id
  ip_protocol       = "tcp"
  from_port         = var.app_port
  to_port           = var.app_port
  cidr_ipv4         = "${aws_eip.this.public_ip}/32"
}

resource "aws_vpc_security_group_ingress_rule" "allowed" {
  for_each          = toset(var.allowed_cidrs)
  security_group_id = aws_security_group.host.id
  ip_protocol       = "tcp"
  from_port         = var.app_port
  to_port           = var.app_port
  cidr_ipv4         = each.value
}

# Terraform은 기본 egress를 지운다. dnf·Node·Compose 다운로드, S3, SSM, ECR에 나가야 한다.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.host.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---- 코드 묶음: 레포가 private일 수 있어 서버에서 git clone하지 않는다 ----
resource "aws_s3_bucket" "bundle" {
  bucket_prefix = "${var.name}-bundle-"
  # 묶음만 담는 전용 버킷이라 destroy 때 같이 지운다.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "bundle" {
  bucket                  = aws_s3_bucket.bundle.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bundle" {
  bucket = aws_s3_bucket.bundle.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "bundle" {
  bucket = aws_s3_bucket.bundle.id
  key    = "shakedown-local.tar.gz"
  source = var.bundle_path
  etag   = filemd5(var.bundle_path)
}

# ---- 로컬 DB 비밀번호: user_data에 넣지 않는다 (EC2 API로 읽힌다). 서버가 부팅 때 SSM에서 읽는다 ----
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "db_password" {
  name  = "/shakedown/${var.name}/local-db-password"
  type  = "SecureString"
  value = random_password.db.result
}

# ---- 서버 역할: SSM 관리 + 이 묶음·이 비밀번호만 읽기 (+ 선택 ECR pull) ----
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name_prefix        = "${var.name}-host-"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "host" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.bundle.arn}/${aws_s3_object.bundle.key}"]
  }
  # aws/ssm 기본 키로 암호화된 SecureString은 ssm:GetParameter 권한으로 복호화된다.
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.db_password.arn]
  }
  dynamic "statement" {
    for_each = local.ecr ? [1] : []
    content {
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    }
  }
  dynamic "statement" {
    for_each = local.ecr ? [1] : []
    content {
      actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
      resources = var.ecr_repository_arns
    }
  }
}

resource "aws_iam_role_policy" "host" {
  name   = "bundle-secret-image"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "host" {
  name_prefix = "${var.name}-"
  role        = aws_iam_role.host.name
}

# ---- 서버 ----
resource "aws_instance" "host" {
  ami                    = data.aws_ssm_parameter.al2023.insecure_value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name
  # 키 페어 없음: 관리는 SSM만.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }
  user_data = local.bootstrap
  lifecycle {
    # AMI 갱신이나 부트스트랩 수정으로 서버가 교체되면 로컬 DB 볼륨이 사라진다. 코드 갱신은 래퍼의 update(SSM)로 한다.
    ignore_changes = [ami, user_data]
  }
  # 역할 권한과 묶음이 준비된 뒤 부팅해야 부트스트랩이 실패하지 않는다.
  depends_on = [aws_iam_role_policy.host, aws_iam_role_policy_attachment.ssm, aws_route.internet, aws_s3_object.bundle]
}

resource "aws_eip_association" "this" {
  instance_id   = aws_instance.host.id
  allocation_id = aws_eip.this.id
}
