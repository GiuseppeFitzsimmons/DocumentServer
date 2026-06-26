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

data "hcloud_ssh_key" "dev" {
  name = "euro-office-deploy"
}

# --- Firewall (open — dev environment) ---

resource "hcloud_firewall" "dev" {
  name = "euro-office-dev"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "3000"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "8080"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# --- Persistent Volume for data (PostgreSQL + file storage) ---

resource "hcloud_volume" "dev_data" {
  name     = "euro-office-dev-data"
  size     = 10 # GB
  location = var.location
  format   = "ext4"

  labels = {
    project = "euro-office"
    env     = "dev"
    role    = "data"
  }
}

# --- Dev Server (single box, everything runs here) ---

resource "hcloud_server" "dev" {
  name        = "euro-office-dev"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.dev.id]

  firewall_ids = [hcloud_firewall.dev.id]

  user_data = templatefile("${path.module}/cloud-init-dev.yaml", {
    repo_url       = var.repo_url
    jwt_secret     = var.jwt_secret
    db_password    = var.db_password
    session_secret = var.session_secret
    dev_domain     = var.dev_domain
    ssh_public_key = var.ssh_public_key
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  labels = {
    project = "euro-office"
    env     = "dev"
  }
}

# --- Attach volume to server ---

resource "hcloud_volume_attachment" "dev_data" {
  volume_id = hcloud_volume.dev_data.id
  server_id = hcloud_server.dev.id
  automount = true
}

output "dev_ip" {
  value = hcloud_server.dev.ipv4_address
}
