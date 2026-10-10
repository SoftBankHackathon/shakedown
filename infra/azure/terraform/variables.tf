variable "subscription_id" {
  description = "해커톤 구독 ID. 회사 구독에 만들지 않도록 scripts/terraform.sh가 az 로그인 구독과 같은지 먼저 확인한다."
  type        = string
}

variable "resource_group" {
  description = "스택 하나 = 리소스 그룹 하나 = DB 엔진 하나 (AWS와 같은 원칙)"
  type        = string
  validation {
    condition     = can(regex("^rg-shakedown-[a-z0-9-]{1,40}$", var.resource_group))
    error_message = "리소스 그룹 이름은 rg-shakedown-으로 시작해야 합니다 (어댑터 설정 검증과 같음)."
  }
}

variable "location" {
  type    = string
  default = "koreacentral"
}

variable "database_engine" {
  type    = string
  default = "postgres"
  validation {
    condition     = contains(["postgres", "mysql", "mongodb"], var.database_engine)
    error_message = "database_engine은 postgres, mysql, mongodb 중 하나입니다."
  }
}

variable "project_id" {
  description = "이 스택을 쓰는 엔진 프로젝트 ID (어댑터 설정 projectId)"
  type        = string
  default     = "prj_board"
}

variable "db_name" {
  type    = string
  default = "board_db"
}

variable "db_username" {
  type    = string
  default = "app"
}

variable "port" {
  type    = number
  default = 8080
}

variable "config_path" {
  description = "만들어 둘 어댑터 설정 파일 경로 (비밀값 없음)"
  type        = string
}
