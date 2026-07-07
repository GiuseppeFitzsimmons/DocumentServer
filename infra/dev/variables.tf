variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
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

variable "dev_domain" {
  description = "Domain for the dev environment"
  type        = string
  default     = "dev.eurobureau.eu"
}

variable "s3_endpoint" {
  description = "S3-compatible endpoint URL"
  type        = string
  default     = ""
}

variable "s3_bucket" {
  description = "S3 bucket name"
  type        = string
  default     = ""
}

variable "s3_access_key" {
  description = "S3 access key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "s3_secret_key" {
  description = "S3 secret key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "s3_region" {
  description = "S3 region"
  type        = string
  default     = "par"
}

variable "smtp_host" {
  description = "SMTP relay host"
  type        = string
  default     = ""
}

variable "smtp_port" {
  description = "SMTP port"
  type        = number
  default     = 587
}

variable "smtp_user" {
  description = "SMTP username"
  type        = string
  default     = ""
}

variable "smtp_pass" {
  description = "SMTP password"
  type        = string
  sensitive   = true
  default     = ""
}
