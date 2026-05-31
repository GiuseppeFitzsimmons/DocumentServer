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
    jwt_secret = var.jwt_secret
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


