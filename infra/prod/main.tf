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

# --- SSH Key (existing) ---

data "hcloud_ssh_key" "deploy" {
  name = "euro-office-deploy"
}

# --- Private Network (existing — import this) ---

resource "hcloud_network" "prod" {
  name     = "euro-office-internal"
  ip_range = "10.0.0.0/16"

  labels = {
    project = "euro-office"
    env     = "prod"
  }
}

resource "hcloud_network_subnet" "prod" {
  network_id   = hcloud_network.prod.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.0.0.0/24"
}

# --- Firewalls ---

resource "hcloud_firewall" "proxy" {
  name = "euro-office-prod-proxy"

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

resource "hcloud_firewall" "app" {
  name = "euro-office-prod-app"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "any"
    source_ips = ["10.0.0.0/24"]
  }
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["10.0.0.0/24"]
  }
}

resource "hcloud_firewall" "db" {
  name = "euro-office-prod-db"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "any"
    source_ips = ["10.0.0.0/24"]
  }
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["10.0.0.0/24"]
  }
}

# --- DB Server ---

resource "hcloud_server" "prod_db" {
  name        = "euro-office-prod-db"
  image       = "ubuntu-24.04"
  server_type = "cx23"
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.deploy.id]

  firewall_ids = [hcloud_firewall.db.id]

  user_data = templatefile("${path.module}/cloud-init-db.yaml", {
    db_password = var.db_password
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = false
  }

  labels = {
    project = "euro-office"
    env     = "prod"
    role    = "db"
  }
}

resource "hcloud_server_network" "prod_db" {
  server_id  = hcloud_server.prod_db.id
  network_id = hcloud_network.prod.id
  ip         = "10.0.0.10"
}

# --- App Server A ---

resource "hcloud_server" "prod_app_a" {
  name        = "euro-office-prod-app-a"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.deploy.id]

  firewall_ids = [hcloud_firewall.app.id]

  user_data = templatefile("${path.module}/cloud-init-app.yaml", {
    repo_url       = var.repo_url
    jwt_secret     = var.jwt_secret
    db_password    = var.db_password
    session_secret = var.session_secret
    db_host        = "10.0.0.10"
    redis_host     = "10.0.0.10"
    domain         = var.domain
    s3_endpoint    = var.ovh_s3_endpoint
    s3_bucket      = var.ovh_s3_bucket
    s3_access_key  = var.ovh_s3_access_key
    s3_secret_key  = var.ovh_s3_secret_key
    s3_region      = var.ovh_s3_region
    smtp_host      = var.smtp_host
    smtp_port      = var.smtp_port
    smtp_user      = var.smtp_user
    smtp_pass      = var.smtp_pass
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = false
  }

  labels = {
    project = "euro-office"
    env     = "prod"
    role    = "app"
  }
}

resource "hcloud_server_network" "prod_app_a" {
  server_id  = hcloud_server.prod_app_a.id
  network_id = hcloud_network.prod.id
  ip         = "10.0.0.11"
}

# --- App Server B ---

resource "hcloud_server" "prod_app_b" {
  name        = "euro-office-prod-app-b"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.deploy.id]

  firewall_ids = [hcloud_firewall.app.id]

  user_data = templatefile("${path.module}/cloud-init-app.yaml", {
    repo_url       = var.repo_url
    jwt_secret     = var.jwt_secret
    db_password    = var.db_password
    session_secret = var.session_secret
    db_host        = "10.0.0.10"
    redis_host     = "10.0.0.10"
    domain         = var.domain
    s3_endpoint    = var.ovh_s3_endpoint
    s3_bucket      = var.ovh_s3_bucket
    s3_access_key  = var.ovh_s3_access_key
    s3_secret_key  = var.ovh_s3_secret_key
    s3_region      = var.ovh_s3_region
    smtp_host      = var.smtp_host
    smtp_port      = var.smtp_port
    smtp_user      = var.smtp_user
    smtp_pass      = var.smtp_pass
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = false
  }

  labels = {
    project = "euro-office"
    env     = "prod"
    role    = "app"
  }
}

resource "hcloud_server_network" "prod_app_b" {
  server_id  = hcloud_server.prod_app_b.id
  network_id = hcloud_network.prod.id
  ip         = "10.0.0.12"
}

# --- Proxy Server ---

resource "hcloud_server" "prod_proxy" {
  name        = "euro-office-prod-proxy"
  image       = "ubuntu-24.04"
  server_type = "cx23"
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.deploy.id]

  firewall_ids = [hcloud_firewall.proxy.id]

  user_data = templatefile("${path.module}/cloud-init-proxy.yaml", {
    domain   = var.domain
    app_a_ip = "10.0.0.11"
    app_b_ip = "10.0.0.12"
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = false
  }

  labels = {
    project = "euro-office"
    env     = "prod"
    role    = "proxy"
  }
}

resource "hcloud_server_network" "prod_proxy" {
  server_id  = hcloud_server.prod_proxy.id
  network_id = hcloud_network.prod.id
  ip         = "10.0.0.2"
}

# --- Outputs ---

output "prod_proxy_ip" {
  value = hcloud_server.prod_proxy.ipv4_address
}

output "prod_app_a_ip" {
  value = hcloud_server.prod_app_a.ipv4_address
}

output "prod_app_b_ip" {
  value = hcloud_server.prod_app_b.ipv4_address
}

output "prod_db_ip" {
  value = hcloud_server.prod_db.ipv4_address
}
