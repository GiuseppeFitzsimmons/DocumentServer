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
