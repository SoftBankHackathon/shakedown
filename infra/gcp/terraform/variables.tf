variable "project" {
  description = "GCP 프로젝트 ID. scripts/terraform.sh가 gcloud 현재 프로젝트와 같은지 먼저 확인한다."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project))
    error_message = "GCP 프로젝트 ID 형식이 아닙니다."
  }
}

variable "region" {
  description = "어댑터 설정 스키마(src/config.ts)와 엔진이 asia-northeast3만 받는다."
  type        = string
  default     = "asia-northeast3"
  validation {
    condition     = var.region == "asia-northeast3"
    error_message = "region은 asia-northeast3만 됩니다 (src/config.ts의 literal)."
  }
}

variable "app_project_id" {
  description = "이 스택을 쓰는 엔진 프로젝트 ID (설정의 projectId)"
  type        = string
  default     = "prj_board"
  validation {
    condition     = can(regex("^[a-zA-Z0-9_-]{1,64}$", var.app_project_id))
    error_message = "app_project_id는 영문·숫자·_·- 1~64자입니다."
  }
}

variable "name_suffix" {
  description = "기존 스택 옆에 별도 스택을 만들 때 붙이는 접미사 (예: -tf). 비우면 provision.sh와 같은 이름."
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^(-[a-z0-9]{1,8})?$", var.name_suffix))
    error_message = "name_suffix는 비우거나 '-'로 시작하는 소문자·숫자 1~8자입니다 (예: -tf)."
  }
}

variable "create_private_service_access" {
  description = "사설망 대역·피어링을 만든다. 피어링은 default 네트워크에 하나만 있으므로 별도 스택은 false로 두고 기존 것을 읽는다."
  type        = bool
  default     = true
}

variable "create_artifact_repository" {
  description = "Artifact Registry 저장소를 만든다. 별도 스택은 false로 두고 기존 shakedown 저장소를 같이 쓴다 (이미지는 digest로 구분)."
  type        = bool
  default     = true
}

variable "sql_deletion_protection" {
  description = "Terraform 쪽 Cloud SQL 삭제 보호. destroy 전에 false로 한 번 apply한다."
  type        = bool
  default     = true
}

variable "config_path" {
  description = "만들어 둘 어댑터 설정 파일 경로 (비밀값 없음)"
  type        = string
}
