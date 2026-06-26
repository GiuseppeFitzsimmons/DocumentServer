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
  description = "Hetzner server type"
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
  default     = "dev-jwt-secret-2026"
}

variable "db_password" {
  description = "PostgreSQL password"
  type        = string
  sensitive   = true
  default     = "dev-db-password"
}

variable "session_secret" {
  description = "Session cookie secret"
  type        = string
  sensitive   = true
  default     = "dev-session-secret-sixteen-chars"
}

variable "dev_domain" {
  description = "Domain for the dev environment"
  type        = string
  default     = "dev.eurobureau.eu"
}
