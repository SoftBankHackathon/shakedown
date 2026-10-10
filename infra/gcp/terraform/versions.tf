# scripts/provision.sh를 Terraform으로 옮긴 것이다 (docs/terraform-migration-aws-gcp.md 2절).
# Cloud Run 서비스·Job·run.invoker 권한은 어댑터가 배포마다 통째로 쓰므로 여기서 만들지 않는다.
# 상태 파일에는 DB 비밀번호가 들어가므로 Git 밖(.data, gitignore)에 둔다. 스택마다 workspace 하나.
terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 8.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    time   = { source = "hashicorp/time", version = "~> 0.12" }
    local  = { source = "hashicorp/local", version = "~> 2.5" }
  }
  backend "local" {
    path          = "../../../.data/gcp/terraform/default.tfstate"
    workspace_dir = "../../../.data/gcp/terraform"
  }
}

provider "google" {
  project = var.project
  region  = var.region
  # 사용자 ADC로 API를 부를 때 요금·한도를 이 프로젝트에 매긴다 (어댑터의 x-goog-user-project와 같은 이유).
  billing_project       = var.project
  user_project_override = true
}
