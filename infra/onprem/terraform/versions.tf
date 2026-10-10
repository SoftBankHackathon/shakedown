# 온프레미스 호스트를 AWS EC2로 흉내 낸다 (docs/terraform-migration-aws-gcp.md 3절).
# 서버 안에서는 로컬 어댑터(infra/local)의 direct 모드가 돈다. 2026-10-10 EC2 실측(docs/experiments)과 같은 조건이다.
# 상태 파일에는 로컬 DB 비밀번호가 들어가므로 Git 밖(.data, gitignore)에 둔다. 스택마다 workspace 하나.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    local  = { source = "hashicorp/local", version = "~> 2.5" }
  }
  backend "local" {
    path          = "../../../.data/onprem/terraform/default.tfstate"
    workspace_dir = "../../../.data/onprem/terraform"
  }
}

provider "aws" {
  region              = local.region
  profile             = var.profile
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Project = "shakedown", Stack = var.name, Role = "onprem-host", ManagedBy = "terraform" }
  }
}
