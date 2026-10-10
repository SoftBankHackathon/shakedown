# 어댑터 설정(src/config.ts configSchema와 같은 이름). 비밀값은 없고 Key Vault 주소만 있다.
locals {
  adapter_config = {
    subscriptionId = var.subscription_id
    tenantId       = data.azurerm_client_config.current.tenant_id
    resourceGroup  = azurerm_resource_group.this.name
    projectId      = var.project_id
    containerApp   = azurerm_container_app.app.name
    initJob        = azurerm_container_app_job.init.name
    repositoryUri  = "${azurerm_container_registry.this.login_server}/shakedown-board"
    # ingress는 어댑터가 껐다 켜므로(DELETE) 환경 기본 도메인으로 주소를 만든다.
    publicUrl           = "https://${azurerm_container_app.app.name}.${azurerm_container_app_environment.this.default_domain}"
    dbEngine            = var.database_engine
    dbHost              = local.db.host
    dbName              = var.db_name
    dbUsername          = var.db_username
    dbPasswordSecretUri = local.db_password_uri
    dbUrlSecretUri      = local.db_url_uri
    secrets             = {}
    port                = var.port
  }
}

resource "local_file" "adapter_config" {
  filename        = var.config_path
  content         = "${jsonencode(local.adapter_config)}\n"
  file_permission = "0600"
}

output "adapter_config" {
  value = local.adapter_config
}
