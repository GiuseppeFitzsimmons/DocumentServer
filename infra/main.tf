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

# --- SSH Keys ---

resource "hcloud_ssh_key" "default" {
  name       = "euro-office-deploy"
  public_key = var.ssh_public_key
}

# --- Firewalls ---

resource "hcloud_firewall" "proxy" {
  name = "proxy"

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
}

resource "hcloud_firewall" "euro_office" {
  name = "euro-office"

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
    source_ips = ["${var.proxy_private_ip}/32"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["${var.proxy_private_ip}/32"]
  }
}

# --- Persistent Volume for data (PostgreSQL + file storage) ---

resource "hcloud_volume" "data" {
  name     = "euro-office-data"
  size     = 50 # GB
  location = var.location
  format   = "ext4"

  lifecycle {
    prevent_destroy = true
  }

  labels = {
    project = "euro-office"
    role    = "data"
  }
}

# --- Server ---

resource "hcloud_server" "euro_office" {
  name        = "euro-office"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  ssh_keys    = concat(
    [hcloud_ssh_key.default.id],
    [for k in hcloud_ssh_key.secondary : k.id]
  )

  firewall_ids = [hcloud_firewall.euro_office.id]

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    jwt_secret       = var.jwt_secret
    db_password      = var.db_password
    session_secret   = var.session_secret
    repo_url         = var.repo_url
    mail_domain      = var.mail_domain
    dkim_private_key = var.dkim_private_key
    smtp_host        = var.smtp_host
    smtp_port        = var.smtp_port
    smtp_user        = var.smtp_user
    smtp_pass        = var.smtp_pass
    ovh_s3_endpoint  = var.ovh_s3_endpoint
    ovh_s3_bucket    = var.ovh_s3_bucket
    ovh_s3_access_key = var.ovh_s3_access_key
    ovh_s3_secret_key = var.ovh_s3_secret_key
    ovh_s3_region    = var.ovh_s3_region
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

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.euro_office.id
  automount = true
}

# --- Private Network ---

resource "hcloud_network" "internal" {
  name     = "euro-office-internal"
  ip_range = var.private_network_subnet
}

resource "hcloud_network_subnet" "internal" {
  network_id   = hcloud_network.internal.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = var.private_network_subnet
}

resource "hcloud_server_network" "backend" {
  server_id  = hcloud_server.euro_office.id
  network_id = hcloud_network.internal.id
  ip         = var.backend_private_ip

  depends_on = [hcloud_network_subnet.internal]
}

# --- Proxy Server ---

resource "hcloud_server" "proxy" {
  name        = "euro-office-proxy"
  image       = "ubuntu-24.04"
  server_type = var.proxy_server_type
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.default.id]

  firewall_ids = [hcloud_firewall.proxy.id]

  user_data = templatefile("${path.module}/cloud-init-proxy.yaml", {
    nginx_config_b64     = base64encode(file("${path.module}/../deploy/nginx/nginx.conf"))
    refresh_cidrs_b64    = base64encode(file("${path.module}/../deploy/scripts/refresh-cidrs-nginx.sh"))
    maintenance_page_b64 = base64encode(file("${path.module}/../deploy/maintenance.html"))
    proxy_domain         = var.proxy_domain
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  labels = {
    project = "euro-office"
    role    = "proxy"
  }
}

resource "hcloud_server_network" "proxy" {
  server_id  = hcloud_server.proxy.id
  network_id = hcloud_network.internal.id
  ip         = var.proxy_private_ip

  depends_on = [hcloud_network_subnet.internal]
}
