locals {
  repo_id   = "shakedown"
  psa_range = "shakedown-psa"
  instance  = "shakedown-pg${var.name_suffix}"
  secret_id = "shakedown${var.name_suffix}-db-password"
  db_name   = "board_db"
  db_user   = "board"
  service   = "shakedown-board${var.name_suffix}"
  apis = ["run.googleapis.com", "sqladmin.googleapis.com", "compute.googleapis.com", "servicenetworking.googleapis.com",
  "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "cloudresourcemanager.googleapis.com", "logging.googleapis.com"]
  # 서비스 계정을 지정하지 않은 Cloud Run 서비스·Job은 Compute Engine 기본 서비스 계정으로 돈다.
  run_sa = "${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)
  service  = each.value
  # 다른 스택·어댑터도 같은 API를 쓰므로 destroy 때 끄지 않는다.
  disable_on_destroy         = false
  disable_dependent_services = false
}

# API를 켠 직후에는 전파가 늦고, Compute 기본 서비스 계정도 비동기로 생긴다 (Azure의 RBAC 90초 대기와 같은 이유).
resource "time_sleep" "apis" {
  depends_on      = [google_project_service.apis]
  create_duration = "60s"
}

data "google_project" "this" {
  project_id = var.project
}

# 새 프로젝트에서는 compute API가 켜지기 전이라 plan 때 읽을 수 없다. depends_on으로 apply 때 읽게 한다.
data "google_compute_network" "default" {
  name       = "default"
  depends_on = [time_sleep.apis]
}

# ---- Artifact Registry ----
resource "google_artifact_registry_repository" "this" {
  count         = var.create_artifact_repository ? 1 : 0
  repository_id = local.repo_id
  location      = var.region
  format        = "DOCKER"
  depends_on    = [time_sleep.apis]
}

data "google_artifact_registry_repository" "existing" {
  count         = var.create_artifact_repository ? 0 : 1
  repository_id = local.repo_id
  location      = var.region
  depends_on    = [time_sleep.apis]
}

# ---- 사설망 연결 (Cloud SQL 사설 IP의 전제) ----
resource "google_compute_global_address" "psa" {
  count         = var.create_private_service_access ? 1 : 0
  name          = local.psa_range
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = data.google_compute_network.default.id
}

resource "google_service_networking_connection" "psa" {
  count                   = var.create_private_service_access ? 1 : 0
  network                 = data.google_compute_network.default.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa[0].name]
  # Cloud SQL을 지운 직후에는 사설 IP 해제가 늦어 피어링 삭제가 자주 실패한다. destroy 때 GCP에 남겨 둔다.
  deletion_policy = "ABANDON"
}

# 별도 스택: 기존 대역이 있는지만 확인한다. 피어링은 대역 이름으로 이어져 있어 Cloud SQL이 그대로 쓴다.
data "google_compute_global_address" "psa" {
  count      = var.create_private_service_access ? 0 : 1
  name       = local.psa_range
  depends_on = [time_sleep.apis]
}

# ---- Cloud SQL PostgreSQL 17 ----
resource "google_sql_database_instance" "db" {
  name             = local.instance
  database_version = "POSTGRES_17"
  region           = var.region
  # Terraform 쪽 보호. API의 settings.deletion_protection_enabled와는 다른 값이다.
  deletion_protection = var.sql_deletion_protection
  settings {
    # PostgreSQL 16 이상은 edition을 안 주면 Enterprise Plus가 되어 db-f1-micro를 쓸 수 없다.
    edition           = "ENTERPRISE"
    tier              = "db-f1-micro"
    availability_type = "ZONAL"
    # gcloud sql instances create는 자동 백업을 켜지만 Terraform 기본값은 꺼져 있다. provision.sh와 맞춘다.
    # (디스크 10GB SSD·자동 증가는 두 쪽 기본값이 같다. 그 밖의 차이는 첫 plan에서 확인 — 명세 2.2 각주 3)
    backup_configuration {
      enabled = true
    }
    ip_configuration {
      ipv4_enabled    = false
      private_network = data.google_compute_network.default.id
      # ssl_mode는 기본값(평문 허용)을 둔다. 어댑터가 sslmode 없는 JDBC로 접속한다.
    }
  }
  # 비용을 멈출 때 activation-policy=never로 끄는데(README 비용 멈추기), 다음 apply가 다시 켜지 않게 한다.
  lifecycle {
    ignore_changes = [settings[0].activation_policy]
  }
  depends_on = [google_service_networking_connection.psa, data.google_compute_global_address.psa]
}

resource "google_sql_database" "db" {
  name     = local.db_name
  instance = google_sql_database_instance.db.name
  # 인스턴스와 함께 지워지므로 따로 DROP하지 않는다.
  deletion_policy = "ABANDON"
}

# ---- DB 비밀번호: Secret Manager에만 두고 Cloud Run이 latest로 읽는다 ----
resource "random_password" "db" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "db_password" {
  secret_id = local.secret_id
  replication {
    auto {}
  }
  depends_on = [time_sleep.apis]
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

resource "google_sql_user" "app" {
  name     = local.db_user
  instance = google_sql_database_instance.db.name
  password = random_password.db.result
  # 스키마 초기화가 만든 테이블을 이 사용자가 소유해서 DROP ROLE이 실패한다. 인스턴스와 함께 지워진다.
  deletion_policy = "ABANDON"
}

# 비권한적 member만 쓴다. _iam_policy·_iam_binding은 다른 권한을 지운다.
resource "google_secret_manager_secret_iam_member" "run_reads_password" {
  secret_id  = google_secret_manager_secret.db_password.id
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${local.run_sa}"
  depends_on = [time_sleep.apis]
}
