variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "server_type" {
  description = "Hetzner server type for app servers"
  type        = string
  default     = "cx23"
}

variable "location" {
  description = "Hetzner datacenter location"
  type        = string
  default     = "fsn1"
}

variable "repo_url" {
  description = "Git repository URL"
  type        = string
  default     = "https://github.com/GiuseppeFitzsimmons/DocumentServer.git"
}

variable "domain" {
  description = "Production domain"
  type        = string
  default     = "eurobureau.eu"
}

variable "jwt_secret" {
  description = "JWT secret for Document Server"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "PostgreSQL password"
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Session cookie secret"
  type        = string
  sensitive   = true
}

variable "smtp_host" {
  description = "SMTP relay host"
  type        = string
}

variable "smtp_port" {
  description = "SMTP port"
  type        = number
  default     = 587
}

variable "smtp_user" {
  description = "SMTP username"
  type        = string
}

variable "smtp_pass" {
  description = "SMTP password"
  type        = string
  sensitive   = true
}

variable "ovh_s3_endpoint" {
  description = "OVH S3 endpoint URL"
  type        = string
  default     = ""
}

variable "ovh_s3_bucket" {
  description = "OVH S3 bucket name"
  type        = string
  default     = ""
}

variable "ovh_s3_access_key" {
  description = "OVH S3 access key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "ovh_s3_secret_key" {
  description = "OVH S3 secret key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "ovh_s3_region" {
  description = "OVH S3 region"
  type        = string
  default     = "eu-west-par"
}

variable "ssh_public_key" {
  description = "SSH public key (unused in multi-server — key is pre-existing)"
  type        = string
  default     = ""
}

variable "resend_api_key" {
  description = "Resend API key (unused — using SMTP)"
  type        = string
  default     = ""
}
