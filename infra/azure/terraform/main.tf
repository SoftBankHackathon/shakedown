locals {
  # Bicep uniqueString(resourceGroup().id)와 같은 역할: 전역 고유 이름(ACR·Key Vault·DB 서버)의 접미사. 계획 단계에서 알 수 있게 입력값으로 만든다.
  suffix = substr(sha1("${var.subscription_id}/${var.resource_group}"), 0, 13)

  # 엔진별 지식은 이 표에만 둔다 (src/config.ts DATABASE_ENGINES와 같은 엔진·호스트 형식).
  engines = {
    postgres = {
      server     = "sd-pg-${local.suffix}"
      host       = "sd-pg-${local.suffix}.postgres.database.azure.com"
      dns_zone   = "sd-${local.suffix}.private.postgres.database.azure.com"
      delegation = "Microsoft.DBforPostgreSQL/flexibleServers"
      namespace  = "Microsoft.DBforPostgreSQL"
    }
    mysql = {
      server     = "sd-my-${local.suffix}"
      host       = "sd-my-${local.suffix}.mysql.database.azure.com"
      dns_zone   = "sd-${local.suffix}.private.mysql.database.azure.com"
      delegation = "Microsoft.DBforMySQL/flexibleServers"
      namespace  = "Microsoft.DBforMySQL"
    }
    # Cosmos DB for MongoDB vCore는 위임 서브넷이 아니라 private endpoint로 붙는다.
    mongodb = {
      server     = "sd-mongo-${local.suffix}"
      host       = "sd-mongo-${local.suffix}.global.mongocluster.cosmos.azure.com"
      dns_zone   = "privatelink.mongocluster.cosmos.azure.com"
      delegation = null
      namespace  = "Microsoft.DocumentDB"
    }
  }
  db = local.engines[var.database_engine]

  providers = ["Microsoft.App", "Microsoft.OperationalInsights", "Microsoft.KeyVault", "Microsoft.ContainerRegistry",
  "Microsoft.Network", "Microsoft.ManagedIdentity", local.db.namespace]

  # 비밀번호가 든 접속 URL (packages/contracts databaseUrl과 같은 모양, Cosmos는 SRV + SCRAM + retrywrites=false). Key Vault db-url에만 둔다.
  credentials = "${urlencode(var.db_username)}:${urlencode(random_password.db.result)}"
  db_url = {
    postgres = "postgresql://${local.credentials}@${local.db.host}:5432/${var.db_name}?sslmode=require"
    mysql    = "mysql://${local.credentials}@${local.db.host}:3306/${var.db_name}?ssl=${urlencode("{\"rejectUnauthorized\":true,\"verifyIdentity\":true}")}"
    mongodb  = "mongodb+srv://${local.credentials}@${local.db.host}/${var.db_name}?tls=true&authMechanism=SCRAM-SHA-256&authSource=admin&retrywrites=false&maxIdleTimeMS=120000"
  }[var.database_engine]

  # 어댑터가 배포 때 이미지·환경변수·복제본을 바꾸므로 처음에는 공개 샘플 이미지로만 만든다.
  placeholder_image = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
  # 비밀은 이름이 아니라 주소로 가리킨다 (버전 없는 주소라 비밀이 바뀌면 다음 리비전이 새 값을 읽는다).
  db_password_uri = "${azurerm_key_vault.this.vault_uri}secrets/db-password"
  db_url_uri      = "${azurerm_key_vault.this.vault_uri}secrets/db-url"
}

resource "azurerm_resource_group" "this" {
  name     = var.resource_group
  location = var.location
}

resource "random_password" "db" {
  length      = 28
  special     = false
  min_upper   = 2
  min_lower   = 2
  min_numeric = 2
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "sd-logs"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = 30 # 최소값, 추가 비용 없음
}

# ---- 네트워크: 앱 서브넷(/23, Container Apps) + DB 서브넷(/24) + DB 사설 DNS ----
resource "azurerm_virtual_network" "this" {
  name                = "sd-vnet"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  address_space       = ["10.40.0.0/16"]
}

resource "azurerm_subnet" "apps" {
  name                 = "apps"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.40.0.0/23"]
  delegation {
    name = "apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "db" {
  name                 = "db"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.40.2.0/24"]
  dynamic "delegation" {
    for_each = local.db.delegation == null ? [] : [local.db.delegation]
    content {
      name = "db"
      service_delegation {
        name    = delegation.value
        actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
      }
    }
  }
  lifecycle {
    ignore_changes = [service_endpoints] # PostgreSQL Flexible이 Microsoft.Storage를 스스로 붙인다
  }
}

resource "azurerm_private_dns_zone" "db" {
  name                = local.db.dns_zone
  resource_group_name = azurerm_resource_group.this.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "db" {
  name                  = "sd-vnet"
  resource_group_name   = azurerm_resource_group.this.name
  private_dns_zone_name = azurerm_private_dns_zone.db.name
  virtual_network_id    = azurerm_virtual_network.this.id
  registration_enabled  = false
}

# ---- DB: 엔진 하나만 만든다 ----
resource "azurerm_postgresql_flexible_server" "db" {
  count                         = var.database_engine == "postgres" ? 1 : 0
  name                          = local.db.server
  location                      = var.location
  resource_group_name           = azurerm_resource_group.this.name
  version                       = "17"
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  administrator_login           = var.db_username
  administrator_password        = random_password.db.result
  delegated_subnet_id           = azurerm_subnet.db.id
  private_dns_zone_id           = azurerm_private_dns_zone.db.id
  public_network_access_enabled = false
  depends_on                    = [azurerm_private_dns_zone_virtual_network_link.db]
  lifecycle {
    ignore_changes = [zone] # Azure가 고른 영역을 그대로 둔다
  }
}

resource "azurerm_postgresql_flexible_server_database" "db" {
  count     = var.database_engine == "postgres" ? 1 : 0
  name      = var.db_name
  server_id = azurerm_postgresql_flexible_server.db[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# MySQL 8.0 (8.4는 preview API에만 있다). TLS 필수가 기본값이다.
resource "azurerm_mysql_flexible_server" "db" {
  count                        = var.database_engine == "mysql" ? 1 : 0
  name                         = local.db.server
  location                     = var.location
  resource_group_name          = azurerm_resource_group.this.name
  version                      = "8.0.21"
  sku_name                     = "B_Standard_B1ms"
  backup_retention_days        = 7
  geo_redundant_backup_enabled = false
  administrator_login          = var.db_username
  administrator_password       = random_password.db.result
  delegated_subnet_id          = azurerm_subnet.db.id
  private_dns_zone_id          = azurerm_private_dns_zone.db.id
  storage {
    size_gb           = 20
    auto_grow_enabled = true
  }
  depends_on = [azurerm_private_dns_zone_virtual_network_link.db]
  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_mysql_flexible_database" "db" {
  count               = var.database_engine == "mysql" ? 1 : 0
  name                = var.db_name
  resource_group_name = azurerm_resource_group.this.name
  server_name         = azurerm_mysql_flexible_server.db[0].name
  charset             = "utf8mb4"
  collation           = "utf8mb4_0900_ai_ci"
}

# Cosmos DB for MongoDB vCore: 가장 작은 유료 등급(M10), 샤드 1개, 공개 접근 없이 private endpoint로만.
# 데이터베이스는 앱이 처음 쓸 때 만들어진다 (MongoDB 동작).
resource "azurerm_mongo_cluster" "db" {
  count                  = var.database_engine == "mongodb" ? 1 : 0
  name                   = local.db.server
  location               = var.location
  resource_group_name    = azurerm_resource_group.this.name
  administrator_username = var.db_username
  administrator_password = random_password.db.result
  version                = "8.0"
  compute_tier           = "M10"
  storage_size_in_gb     = 32
  shard_count            = 1
  high_availability_mode = "Disabled"
  public_network_access  = "Disabled"
}

resource "azurerm_private_endpoint" "db" {
  count               = var.database_engine == "mongodb" ? 1 : 0
  name                = "sd-mongo-pe"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.db.id
  private_service_connection {
    name                           = "mongo"
    private_connection_resource_id = azurerm_mongo_cluster.db[0].id
    subresource_names              = ["MongoCluster"]
    is_manual_connection           = false
  }
  private_dns_zone_group {
    name                 = "mongo"
    private_dns_zone_ids = [azurerm_private_dns_zone.db.id]
  }
}

# ---- 비밀·이미지·관리 ID ----
resource "azurerm_user_assigned_identity" "app" {
  name                = "sd-app-id"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
}

data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "this" {
  name                       = "sd-kv-${substr(local.suffix, 0, 10)}"
  location                   = var.location
  resource_group_name        = azurerm_resource_group.this.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  soft_delete_retention_days = 7
  purge_protection_enabled   = false
}

# 어댑터는 이 두 비밀의 주소만 알고, 값은 Container App이 관리 ID로 읽는다.
# ARM은 비밀 PUT만 받고 DELETE는 405라서 resource 대신 action으로 쓴다. destroy 때는 볼트와 함께 지워진다.
resource "azapi_resource_action" "db_password" {
  type        = "Microsoft.KeyVault/vaults/secrets@2023-07-01"
  resource_id = "${azurerm_key_vault.this.id}/secrets/db-password"
  method      = "PUT"
  body        = { properties = { value = random_password.db.result } }
}

resource "azapi_resource_action" "db_url" {
  type        = "Microsoft.KeyVault/vaults/secrets@2023-07-01"
  resource_id = "${azurerm_key_vault.this.id}/secrets/db-url"
  method      = "PUT"
  body        = { properties = { value = local.db_url } }
}

resource "azurerm_container_registry" "this" {
  name                = "sdacr${local.suffix}"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "Basic"
  admin_enabled       = false
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "vault_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

# 역할 부여가 퍼지기 전에 앱을 만들면 비밀·이미지를 못 읽어 실패할 수 있다 (provision.sh의 90초 대기).
# 비밀 쓰기까지 여기서 기다리므로 앱과 작업은 이것 하나만 depends_on 한다.
resource "time_sleep" "rbac" {
  depends_on      = [azurerm_role_assignment.acr_pull, azurerm_role_assignment.vault_secrets, azapi_resource_action.db_password, azapi_resource_action.db_url]
  create_duration = "90s"
}

# ---- Container Apps ----
resource "azurerm_container_app_environment" "this" {
  name                           = "sd-env"
  location                       = var.location
  resource_group_name            = azurerm_resource_group.this.name
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.this.id
  infrastructure_subnet_id       = azurerm_subnet.apps.id
  internal_load_balancer_enabled = false
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
  lifecycle {
    ignore_changes = [infrastructure_resource_group_name]
  }
}

resource "azurerm_container_app" "app" {
  name                         = "sd-app"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }
  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }
  secret {
    name                = "db-password"
    identity            = azurerm_user_assigned_identity.app.id
    key_vault_secret_id = local.db_password_uri
  }
  ingress {
    external_enabled           = true
    target_port                = var.port
    transport                  = "auto"
    allow_insecure_connections = false
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
  template {
    min_replicas = 0
    max_replicas = 1
    container {
      name   = "app"
      image  = local.placeholder_image
      cpu    = 0.5
      memory = "1Gi"
    }
  }
  # 배포 뒤로는 어댑터가 이미지·환경변수·복제본·비밀·ingress(세션 고정, 차단)를 바꾼다. 다시 apply해도 되돌리지 않는다.
  lifecycle {
    ignore_changes = [template, secret, ingress]
  }
  depends_on = [time_sleep.rbac]
}

# 기존 Spring 샘플용 스키마 초기화 작업 (PostgreSQL 스택만, scripts/schema-init.sh가 이미지만 바꿔 실행)
resource "azurerm_container_app_job" "schema_init" {
  count                        = var.database_engine == "postgres" ? 1 : 0
  name                         = "sd-schema-init"
  location                     = var.location
  resource_group_name          = azurerm_resource_group.this.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 0
  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }
  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }
  secret {
    name                = "db-password"
    identity            = azurerm_user_assigned_identity.app.id
    key_vault_secret_id = local.db_password_uri
  }
  template {
    container {
      name   = "init"
      image  = local.placeholder_image
      cpu    = 0.5
      memory = "1Gi"
      # 어댑터(azure-provider.ts env)가 앱에 넣는 DB 값과 같다. 초기화만 ddl update + schema-init 프로필.
      env {
        name  = "SPRING_DATASOURCE_URL"
        value = "jdbc:postgresql://${local.db.host}:5432/${var.db_name}?sslmode=require"
      }
      env {
        name  = "SPRING_DATASOURCE_USERNAME"
        value = var.db_username
      }
      env {
        name        = "SPRING_DATASOURCE_PASSWORD"
        secret_name = "db-password"
      }
      env {
        name  = "SPRING_PROFILES_ACTIVE"
        value = "schema-init"
      }
      env {
        name  = "SPRING_JPA_HIBERNATE_DDL_AUTO"
        value = "update"
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
  depends_on = [time_sleep.rbac]
}

# runtime.init_command용 범용 작업. 어댑터가 실행마다 이미지·명령·환경변수를 넘기고, 비밀 목록이 바뀔 때만 작업을 갱신한다.
resource "azurerm_container_app_job" "init" {
  name                         = "sd-init"
  location                     = var.location
  resource_group_name          = azurerm_resource_group.this.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 1800
  replica_retry_limit          = 0
  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }
  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }
  secret {
    name                = "db-password"
    identity            = azurerm_user_assigned_identity.app.id
    key_vault_secret_id = local.db_password_uri
  }
  template {
    container {
      name   = "init"
      image  = local.placeholder_image
      cpu    = 0.5
      memory = "1Gi"
    }
  }
  lifecycle {
    ignore_changes = [secret, template]
  }
  depends_on = [time_sleep.rbac]
}
