variable "profile" {
  description = "해커톤 전용 named profile (default 금지)"
  type        = string
  validation {
    condition     = var.profile != "" && var.profile != "default"
    error_message = "default가 아닌 해커톤 전용 named profile을 지정하세요."
  }
}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id는 12자리 숫자입니다."
  }
}

variable "name" {
  type    = string
  default = "shakedown-onprem"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name))
    error_message = "name은 [a-z][a-z0-9-]{2,29}입니다."
  }
}

variable "app_port" {
  description = "앱 공개 포트 (LOCAL_APP_PORT). 9101(제어 API)은 쓸 수 없다."
  type        = number
  default     = 18080
  validation {
    condition     = var.app_port >= 1024 && var.app_port <= 65535 && var.app_port != 9101
    error_message = "app_port는 1024~65535이고 9101이 아니어야 합니다."
  }
}

variable "allowed_cidrs" {
  description = "앱 포트에 들어올 수 있는 IPv4 CIDR (예: 데모장 IP/32). 비우면 서버 자신만 연다. 0.0.0.0/0은 명시적으로 넣어야만 열린다."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for c in var.allowed_cidrs : can(cidrhost(c, 0))])
    error_message = "allowed_cidrs는 IPv4 CIDR 목록입니다."
  }
}

variable "instance_type" {
  type    = string
  default = "t3.medium"
}

variable "root_volume_gb" {
  type    = number
  default = 24
}

variable "node_version" {
  description = "실측 버전 v22.23.2. nodejs.org 공식 배포본을 SHASUMS256으로 확인해 설치한다."
  type        = string
  default     = "22.23.2"
  validation {
    condition     = can(regex("^22\\.[0-9]+\\.[0-9]+$", var.node_version))
    error_message = "로컬 어댑터는 Node 22 이상을 요구한다 (실측은 22)."
  }
}

variable "compose_version" {
  description = "실측 버전 v5.6.0. GitHub 공식 배포본을 .sha256으로 확인해 설치한다."
  type        = string
  default     = "5.6.0"
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.compose_version))
    error_message = "compose_version은 x.y.z입니다."
  }
}

variable "bundle_path" {
  description = "git archive로 만든 infra/local + packages/contracts 묶음(.tar.gz). 래퍼가 만든다."
  type        = string
}

variable "ecr_repository_arns" {
  description = "서버가 이미지를 pull할 ECR 저장소 ARN (선택, 명세 3.4 b안). 비우면 ECR 권한·자격 도우미를 설치하지 않는다."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for v in var.ecr_repository_arns : can(regex("^arn:aws:ecr:ap-northeast-2:[0-9]{12}:repository/.+$", v))])
    error_message = "ecr_repository_arns는 서울 리전 ECR 저장소 ARN 목록입니다."
  }
}

variable "engine_env_path" {
  description = "엔진에 넣을 LOCAL_* 설정을 쓸 파일 (비밀값 없음)"
  type        = string
}
