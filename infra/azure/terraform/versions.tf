# bicep/main.bicep + app.bicep + init.bicep + scripts/provision.sh를 Terraform 하나로 옮긴 것이다.
# 상태 파일에는 DB 비밀번호가 들어가므로 Git 밖(.data, gitignore)에 둔다. 스택(리소스 그룹)마다 workspace 하나.
terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.40" }
    # Key Vault 비밀은 Bicep처럼 ARM(관리 평면)으로 쓴다. azurerm_key_vault_secret은 데이터 평면이라 배포자에게 비밀 쓰기 역할이 따로 필요하다.
    azapi  = { source = "Azure/azapi", version = "~> 2.5" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    time   = { source = "hashicorp/time", version = "~> 0.12" }
    local  = { source = "hashicorp/local", version = "~> 2.5" }
  }
  backend "local" {
    path          = "../../../.data/azure/terraform/default.tfstate"
    workspace_dir = "../../../.data/azure/terraform"
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  # 필요한 서비스만 등록한다 (provision.sh의 NAMESPACES와 같다).
  resource_provider_registrations = "none"
  resource_providers_to_register  = local.providers
  features {
    # destroy 후 같은 이름으로 다시 만들 수 있게 (Key Vault 이름은 7일간 예약된다)
    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}

provider "azapi" {
  subscription_id = var.subscription_id
}
