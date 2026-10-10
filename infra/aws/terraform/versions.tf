# cloudformation/foundation.yaml을 Terraform으로 옮긴 것이다 (docs/terraform-migration-aws-gcp.md 1절).
# DB는 RDS PostgreSQL·MySQL 또는 EC2 3대 TLS MongoDB 복제 세트(mongo.tf). Mongo 준비 대기(CFN WaitCondition)는 래퍼가 한다.
# ECS 서비스·태스크 정의·오토스케일링은 어댑터가, HTTPS(ACM·443 리스너)는 infra/https가 만든다. 여기서는 만들지 않는다.
# 상태 파일에는 DB 비밀번호가 들어가므로 Git 밖(.data, gitignore)에 둔다. 스택마다 workspace 하나.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    local  = { source = "hashicorp/local", version = "~> 2.5" }
  }
  backend "local" {
    path          = "../../../.data/aws/terraform/default.tfstate"
    workspace_dir = "../../../.data/aws/terraform"
  }
}

provider "aws" {
  region  = local.region
  profile = var.profile
  # 다른 계정(회사 계정 등)으로 로그인돼 있으면 아무것도 바꾸지 않고 멈춘다 (provision.sh의 STS 대조).
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Project = "shakedown", Stack = var.name, ManagedBy = "terraform" }
  }
}
