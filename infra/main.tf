terraform {
  required_version = ">= 1.5"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

# --- SSH Key ---

resource "hcloud_ssh_key" "default" {
  name       = "euro-office-deploy"
  public_key = var.ssh_public_key
}

# --- Firewall ---

resource "hcloud_firewall" "euro_office" {
  name = "euro-office"

  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# --- Persistent Volume for PostgreSQL ---

resource "hcloud_volume" "pg_data" {
  name     = "euro-office-pg-data"
  size     = 10 # GB
  location = var.location
  format   = "ext4"

  lifecycle {
    prevent_destroy = true
  }

  labels = {
    project = "euro-office"
    role    = "database"
  }
}

# --- Server ---

resource "hcloud_server" "euro_office" {
  name        = "euro-office"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.default.id]

  firewall_ids = [hcloud_firewall.euro_office.id]

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    jwt_secret           = var.jwt_secret
    db_password          = var.db_password
    session_secret       = var.session_secret
    repo_url             = var.repo_url
    s3_endpoint          = "https://${var.s3_region}.your-objectstorage.com"
    s3_bucket            = var.s3_bucket_name
    s3_access_key_id     = var.s3_access_key_id
    s3_secret_access_key = var.s3_secret_access_key
    s3_region            = var.s3_region
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  labels = {
    project = "euro-office"
    env     = "poc"
  }
}

# --- Attach volume to server ---

resource "hcloud_volume_attachment" "pg_data" {
  volume_id = hcloud_volume.pg_data.id
  server_id = hcloud_server.euro_office.id
  automount = true
}
