variable "profile" {
  description = "해커톤 전용 named profile. default는 받지 않는다 (어댑터 설정 스키마와 같음)."
  type        = string
  validation {
    condition     = var.profile != "" && var.profile != "default"
    error_message = "default가 아닌 해커톤 전용 named profile을 지정하세요."
  }
}

variable "account_id" {
  description = "기대하는 12자리 AWS 계정 ID"
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id는 12자리 숫자입니다."
  }
}

variable "name" {
  description = "스택 이름 (CFN Name). ECR 저장소·로그 그룹·ECS 클러스터·서비스 이름이 된다. 기존 스택 옆에 시험할 때는 shakedown-tf처럼 다른 이름."
  type        = string
  default     = "shakedown-board"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name))
    error_message = "name은 [a-z][a-z0-9-]{2,29}입니다 (CFN AllowedPattern과 같음)."
  }
}

variable "project_id" {
  description = "이 스택을 쓰는 엔진 프로젝트 ID (설정의 projectId)"
  type        = string
  default     = "prj_board"
  validation {
    condition     = can(regex("^[a-zA-Z0-9_-]{1,64}$", var.project_id))
    error_message = "project_id는 영문·숫자·_·- 1~64자입니다."
  }
}

variable "create_database" {
  type    = bool
  default = true
}

variable "database_engine" {
  type    = string
  default = "postgres"
  validation {
    condition     = contains(["postgres", "mysql", "mongodb"], var.database_engine)
    error_message = "database_engine은 postgres, mysql, mongodb 중 하나입니다."
  }
}

variable "postgres_version" {
  description = "RDS PostgreSQL 17 버전. 기본값이 없다 (CFN과 같음). 서울 db.t3.micro에서 주문 가능한지 plan 때 확인한다."
  type        = string
  default     = null
  validation {
    condition     = var.postgres_version == null || can(regex("^17\\.[0-9]+$", var.postgres_version))
    error_message = "postgres_version은 17.x입니다."
  }
}

variable "mysql_version" {
  type    = string
  default = "8.4.7"
  validation {
    condition     = can(regex("^8\\.4\\.[0-9]+$", var.mysql_version))
    error_message = "mysql_version은 8.4.x입니다."
  }
}

variable "db_name" {
  type    = string
  default = "board_db"
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,63}$", var.db_name))
    error_message = "db_name 형식이 아닙니다."
  }
}

variable "app_port" {
  type    = number
  default = 8080
  validation {
    condition     = var.app_port >= 1 && var.app_port <= 65535
    error_message = "app_port는 1~65535입니다."
  }
}

variable "additional_secrets" {
  description = "앱이 읽을 외부 Secrets Manager 비밀 {참조 이름 = ARN}. 실행 역할 권한(CFN AdditionalSecretArns)과 설정의 secrets에 같이 들어간다."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for k, v in var.additional_secrets : can(regex("^[A-Za-z0-9_-]{1,100}$", k)) && can(regex("^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", v))])
    error_message = "additional_secrets는 {이름 = secretsmanager ARN} 형식입니다."
  }
}

variable "additional_kms_key_arns" {
  description = "위 비밀을 암호화한 고객 관리 KMS 키 ARN"
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for v in var.additional_kms_key_arns : can(regex("^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-zA-Z0-9-]+$", v))])
    error_message = "additional_kms_key_arns는 kms key ARN 목록입니다."
  }
}

variable "enable_mongo_snapshots" {
  description = "Mongo EBS 일일 스냅샷(DLM). CFN 기본값은 true지만 실험 계정에서 SCP로 막혀 있었다 → 기본 false (명세 1.8 위험 8)."
  type        = bool
  default     = false
}

variable "https_control_url" {
  description = "infra/https 서비스 주소 (선택, 예: http://127.0.0.1:9301)"
  type        = string
  default     = null
}

variable "skip_final_snapshot" {
  description = "destroy 때 RDS 최종 스냅샷을 건너뛴다. CFN DeletionPolicy: Snapshot과 맞추려면 false."
  type        = bool
  default     = false
}

variable "config_path" {
  description = "만들어 둘 어댑터 설정 파일 경로 (비밀값 없음)"
  type        = string
}
