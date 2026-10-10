# 실계정 없이 도는 시험 (terraform test). GCP·시간 provider는 가짜로 바꾸고, random·local은 진짜를 쓴다.
# 설정 파일 내용은 provision.sh가 쓰던 것(config.example.json 형식)과 같은지 비교한다. 실계정 apply 때는 래퍼가 loadConfig로 한 번 더 검사한다.
mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "700410260240" }
  }
  mock_data "google_compute_network" {
    defaults = { name = "default", id = "projects/shakedown-511106/global/networks/default" }
  }
  mock_data "google_artifact_registry_repository" {
    defaults = { location = "asia-northeast3", repository_id = "shakedown" }
  }
  mock_resource "google_sql_database_instance" {
    defaults = { private_ip_address = "10.20.0.3" }
  }
}

mock_provider "time" {}

variables {
  project     = "shakedown-511106"
  config_path = "../../../.data/gcp/test/offline-default.json"
}

run "기본_스택은_provision_sh와_같은_이름으로_만든다" {
  command = apply

  assert {
    condition     = length(google_compute_global_address.psa) == 1 && length(google_service_networking_connection.psa) == 1
    error_message = "기본 스택은 사설망 대역과 피어링을 만들어야 합니다."
  }
  assert {
    condition     = length(google_artifact_registry_repository.this) == 1
    error_message = "기본 스택은 Artifact Registry 저장소를 만들어야 합니다."
  }
  assert {
    condition     = google_sql_database_instance.db.name == "shakedown-pg" && google_sql_database_instance.db.settings[0].edition == "ENTERPRISE" && google_sql_database_instance.db.settings[0].tier == "db-f1-micro"
    error_message = "Cloud SQL 이름·edition·tier가 provision.sh와 다릅니다."
  }
  assert {
    condition     = google_sql_database_instance.db.settings[0].backup_configuration[0].enabled
    error_message = "gcloud 기본값과 맞추려면 자동 백업이 켜져 있어야 합니다."
  }
  assert {
    condition     = google_secret_manager_secret_iam_member.run_reads_password.member == "serviceAccount:700410260240-compute@developer.gserviceaccount.com"
    error_message = "비밀 읽기 권한은 Compute 기본 서비스 계정에 줘야 합니다."
  }
  assert {
    condition = jsondecode(local_file.adapter_config.content) == {
      gcpProject       = "shakedown-511106"
      gcpProjectNumber = "700410260240"
      region           = "asia-northeast3"
      projectId        = "prj_board"
      serviceName      = "shakedown-board"
      jobName          = "shakedown-board-schema"
      imagePrefixes    = ["asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/"]
      network          = "default"
      subnetwork       = "default"
      dbHost           = "10.20.0.3"
      dbName           = "board_db"
      dbUsername       = "board"
      dbPasswordSecret = "shakedown-db-password"
      port             = 8080
      memory           = "1Gi"
      cpu              = "1"
    }
    error_message = "설정 파일이 provision.sh가 쓰던 내용(config.example.json)과 다릅니다."
  }
}

run "별도_스택은_피어링과_저장소를_만들지_않고_이름에_접미사를_붙인다" {
  command = apply
  variables {
    name_suffix                   = "-tf"
    create_private_service_access = false
    create_artifact_repository    = false
    config_path                   = "../../../.data/gcp/test/offline-separate.json"
  }

  assert {
    condition     = length(google_compute_global_address.psa) == 0 && length(google_service_networking_connection.psa) == 0 && length(google_artifact_registry_repository.this) == 0
    error_message = "별도 스택이 공유 자원(피어링·저장소)을 만들려고 합니다."
  }
  assert {
    condition     = google_sql_database_instance.db.name == "shakedown-pg-tf" && google_secret_manager_secret.db_password.secret_id == "shakedown-tf-db-password"
    error_message = "별도 스택 이름에 접미사가 붙지 않았습니다."
  }
  assert {
    condition     = jsondecode(local_file.adapter_config.content).serviceName == "shakedown-board-tf" && jsondecode(local_file.adapter_config.content).jobName == "shakedown-board-tf-schema"
    error_message = "별도 스택이 기존 Cloud Run 서비스 이름을 씁니다."
  }
  assert {
    condition     = jsondecode(local_file.adapter_config.content).imagePrefixes == ["asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/"]
    error_message = "별도 스택은 기존 저장소 경로를 써야 합니다."
  }
}

run "region은_서울만_받는다" {
  command = plan
  variables {
    region = "us-central1"
  }
  expect_failures = [var.region]
}

run "접미사_형식이_틀리면_거부한다" {
  command = plan
  variables {
    name_suffix = "TF"
  }
  expect_failures = [var.name_suffix]
}
