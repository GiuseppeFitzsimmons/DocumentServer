variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "SSH public key for server access (primary machine)"
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

variable "resend_api_key" {
  description = "Resend API key for transactional email"
  type        = string
  sensitive   = true
}

variable "smtp_host" {
  description = "SMTP relay hostname (e.g. ssl0.ovh.net) — legacy, unused if Resend is configured"
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

# --- Private Network ---

variable "private_network_subnet" {
  description = "CIDR for the private network subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "proxy_private_ip" {
  description = "Private IP address for the proxy server"
  type        = string
  default     = "10.0.1.3"
}

variable "backend_private_ip" {
  description = "Private IP address for the backend server"
  type        = string
  default     = "10.0.1.2"
}

# --- Proxy Server ---

variable "proxy_server_type" {
  description = "Hetzner server type for the proxy server"
  type        = string
  default     = "cx23"
}

variable "proxy_domain" {
  description = "Primary domain for the proxy server TLS certificate"
  type        = string
  default     = "eurobureau.eu"
}
