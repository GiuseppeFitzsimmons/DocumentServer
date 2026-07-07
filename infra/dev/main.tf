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

# --- Private Network ---

resource "hcloud_network" "dev" {
  name     = "euro-office-dev-net"
  ip_range = "10.0.0.0/16"

  labels = {
    project = "euro-office"
    env     = "dev"
  }
}

resource "hcloud_network_subnet" "dev" {
  network_id   = hcloud_network.dev.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.0.1.0/24"
}

# --- Firewalls ---

resource "hcloud_firewall" "proxy" {
  name = "euro-office-dev-proxy"

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
  name = "euro-office-dev-app"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  # App traffic from proxy only (via private network)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["10.0.1.0/24"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "3000"
    source_ips = ["10.0.1.0/24"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "8080"
    source_ips = ["10.0.1.0/24"]
  }
}

resource "hcloud_firewall" "db" {
  name = "euro-office-dev-db"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  # Allow all traffic from private network
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "any"
    source_ips = ["10.0.1.0/24"]
  }
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["10.0.1.0/24"]
  }
}

# --- DB Server ---

resource "hcloud_server" "dev_db" {
  name        = "euro-office-dev-db"
  image       = "ubuntu-24.04"
  server_type = "cx23"
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.dev.id]

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
    env     = "dev"
    role    = "db"
  }
}

resource "hcloud_server_network" "dev_db" {
  server_id  = hcloud_server.dev_db.id
  network_id = hcloud_network.dev.id
  ip         = "10.0.1.10"
}

# --- App Server A ---

resource "hcloud_server" "dev_app_a" {
  name        = "euro-office-dev-app-a"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.dev.id]

  firewall_ids = [hcloud_firewall.app.id]

  user_data = templatefile("${path.module}/cloud-init-app.yaml", {
    repo_url       = var.repo_url
    jwt_secret     = var.jwt_secret
    db_password    = var.db_password
    session_secret = var.session_secret
    db_host        = "10.0.1.10"
    redis_host     = "10.0.1.10"
    dev_domain     = var.dev_domain
    s3_endpoint    = var.s3_endpoint
    s3_bucket      = var.s3_bucket
    s3_access_key  = var.s3_access_key
    s3_secret_key  = var.s3_secret_key
    s3_region      = var.s3_region
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
    env     = "dev"
    role    = "app"
  }
}

resource "hcloud_server_network" "dev_app_a" {
  server_id  = hcloud_server.dev_app_a.id
  network_id = hcloud_network.dev.id
  ip         = "10.0.1.11"
}

# --- App Server B ---

resource "hcloud_server" "dev_app_b" {
  name        = "euro-office-dev-app-b"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.dev.id]

  firewall_ids = [hcloud_firewall.app.id]

  user_data = templatefile("${path.module}/cloud-init-app.yaml", {
    repo_url       = var.repo_url
    jwt_secret     = var.jwt_secret
    db_password    = var.db_password
    session_secret = var.session_secret
    db_host        = "10.0.1.10"
    redis_host     = "10.0.1.10"
    dev_domain     = var.dev_domain
    s3_endpoint    = var.s3_endpoint
    s3_bucket      = var.s3_bucket
    s3_access_key  = var.s3_access_key
    s3_secret_key  = var.s3_secret_key
    s3_region      = var.s3_region
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
    env     = "dev"
    role    = "app"
  }
}

# --- Proxy Server ---

resource "hcloud_server" "dev_proxy" {
  name        = "euro-office-dev-proxy"
  image       = "ubuntu-24.04"
  server_type = "cx23"
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.dev.id]

  firewall_ids = [hcloud_firewall.proxy.id]

  user_data = templatefile("${path.module}/cloud-init-proxy.yaml", {
    dev_domain  = var.dev_domain
    app_a_ip    = "10.0.1.11"
    app_b_ip    = "10.0.1.12"
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = false
  }

  labels = {
    project = "euro-office"
    env     = "dev"
    role    = "proxy"
  }
}

resource "hcloud_server_network" "dev_proxy" {
  server_id  = hcloud_server.dev_proxy.id
  network_id = hcloud_network.dev.id
  ip         = "10.0.1.1"
}

# --- Outputs ---

output "dev_proxy_ip" {
  value = hcloud_server.dev_proxy.ipv4_address
}

output "dev_app_a_ip" {
  value = hcloud_server.dev_app_a.ipv4_address
}

output "dev_app_b_ip" {
  value = hcloud_server.dev_app_b.ipv4_address
}

output "dev_db_ip" {
  value = hcloud_server.dev_db.ipv4_address
}

output "dev_private_network" {
  value = {
    proxy = "10.0.1.1"
    app_a = "10.0.1.11"
    app_b = "10.0.1.12"
    db    = "10.0.1.10"
  }
}
