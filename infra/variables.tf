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
  description = "Hetzner server type (cx23 = 2 vCPU / 4 GB)"
  type        = string
  default     = "cx23"
}

variable "location" {
  description = "Hetzner datacenter location"
  type        = string
  default     = "fsn1"
}

variable "jwt_secret" {
  description = "JWT secret for Document Server API authentication"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "PostgreSQL password for the portal database"
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Secret for signing session cookies"
  type        = string
  sensitive   = true
}

variable "repo_url" {
  description = "Git repository URL to clone on the server"
  type        = string
  default     = "https://github.com/GiuseppeFitzsimmons/DocumentServer.git"
}

variable "dkim_private_key" {
  description = "DKIM private key for email signing (PEM format)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "mail_domain" {
  description = "Domain used for sending email"
  type        = string
  default     = "eurobureau.eu"
}

variable "smtp_host" {
  description = "SMTP relay hostname (e.g. ssl0.ovh.net)"
  type        = string
  default     = ""
}

variable "smtp_port" {
  description = "SMTP relay port (465 for SSL, 587 for STARTTLS)"
  type        = number
  default     = 587
}

variable "smtp_user" {
  description = "SMTP relay username/email"
  type        = string
  default     = ""
}

variable "smtp_pass" {
  description = "SMTP relay password"
  type        = string
  sensitive   = true
  default     = ""
}

# --- OVH Object Storage (replication target) ---

variable "ovh_s3_endpoint" {
  description = "OVH S3-compatible endpoint URL"
  type        = string
  default     = "https://s3.eu-west-par.io.cloud.ovh.net"
}

variable "ovh_s3_bucket" {
  description = "OVH Object Storage bucket name for replication"
  type        = string
  default     = "euro-office-replica"
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
  description = "OVH S3 region (e.g. eu-west-par)"
  type        = string
  default     = "eu-west-par"
}
