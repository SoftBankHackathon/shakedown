# 어댑터 설정 (src/config.ts configSchema와 같은 키, .strict()). 비밀값은 없고 Secret 이름만 있다.
locals {
  repo_location = var.create_artifact_repository ? google_artifact_registry_repository.this[0].location : data.google_artifact_registry_repository.existing[0].location
  repo_name     = var.create_artifact_repository ? google_artifact_registry_repository.this[0].repository_id : data.google_artifact_registry_repository.existing[0].repository_id
  adapter_config = {
    gcpProject       = var.project
    gcpProjectNumber = tostring(data.google_project.this.number)
    region           = var.region
    projectId        = var.app_project_id
    serviceName      = local.service
    jobName          = "${local.service}-schema"
    imagePrefixes    = ["${local.repo_location}-docker.pkg.dev/${var.project}/${local.repo_name}/"]
    # 경로가 아니라 이름이다.
    network    = data.google_compute_network.default.name
    subnetwork = "default"
    dbHost     = google_sql_database_instance.db.private_ip_address
    dbName     = google_sql_database.db.name
    dbUsername = google_sql_user.app.name
    # .id·.name은 projects/... 경로라 쓰면 안 된다. 어댑터는 이름에 latest를 붙여 읽는다.
    dbPasswordSecret = google_secret_manager_secret.db_password.secret_id
    port             = 8080
    memory           = "1Gi"
    cpu              = "1"
  }
}

resource "local_file" "adapter_config" {
  filename        = var.config_path
  content         = "${jsonencode(local.adapter_config)}\n"
  file_permission = "0600"
  # 비밀번호가 Secret Manager에 들어간 뒤에야 설정을 쓴다 (설정이 있으면 어댑터를 띄울 수 있다는 뜻).
  depends_on = [google_secret_manager_secret_version.db_password, google_secret_manager_secret_iam_member.run_reads_password]
}

output "adapter_config" {
  value = local.adapter_config
}
