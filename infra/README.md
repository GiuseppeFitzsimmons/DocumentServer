# Euro-Office Infrastructure (Hetzner Cloud)

Two-server deployment of Euro-Office on Hetzner Cloud: a dedicated nginx reverse proxy for TLS termination, geo-blocking, and request routing, plus a backend server running the application containers.

## Architecture

```
Internet → Proxy Server (nginx, TLS, geo-blocking) → Private Network (10.0.1.0/24) → Backend Server (portal, documentserver, postgres, redis)
```

### Proxy Server
- Runs **nginx** with automatic TLS via Let's Encrypt (certbot)
- Handles geo-blocking using `ngx_http_geo_module` and a weekly-refreshed CIDR whitelist
- Routes requests to the appropriate backend service over the private network
- Redirects `www.eurobureau.eu` → `eurobureau.eu`

### Backend Server
- Runs Docker Compose with: **portal** (:3000), **documentserver** (:80), **postgres**, **redis**
- Only accessible from the proxy server's private IP (firewall-enforced)
- No public HTTP/HTTPS exposure

### Private Network
- Hetzner Cloud private network: `10.0.1.0/24`
- Proxy: `10.0.1.1`, Backend: `10.0.1.2`
- All proxy-to-backend traffic stays off the public internet

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- A Hetzner Cloud account + API token (Project → Security → API Tokens)
- A domain with DNS you control (point A records at the proxy server IP after deploy)
- An SSH key pair

## Quick Start

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

terraform init
terraform plan
terraform apply
```

After apply:
1. Note the `proxy_ipv4` and `server_ipv4` outputs
2. Point your domain's A record (eurobureau.eu and www.eurobureau.eu) to the **proxy** IP
3. Wait 1-2 minutes for cloud-init to complete nginx setup and obtain the TLS certificate
4. Visit `https://eurobureau.eu` — the application should be live

## SSH Access

```bash
# Proxy server
ssh root@<proxy-ip>

# Backend server
ssh root@<backend-ip>
```

Logs:
```bash
# Backend application logs
ssh root@<backend-ip>
cd /opt/euro-office && docker compose logs -f

# Proxy nginx logs
ssh root@<proxy-ip>
tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

## Variables

| Name | Description | Default |
|------|-------------|---------|
| `hcloud_token` | Hetzner API token | — |
| `ssh_public_key` | Your SSH public key | — |
| `domain` | Domain for TLS | — |
| `jwt_secret` | Document Server JWT secret | — |
| `acme_email` | Let's Encrypt notification email | — |
| `server_type` | Hetzner VM size for backend | `cx23` |
| `proxy_server_type` | Hetzner VM size for proxy | `cx23` |
| `proxy_domain` | Primary domain for proxy TLS | `eurobureau.eu` |
| `location` | Hetzner datacenter | `fsn1` |
| `private_network_subnet` | Private network CIDR | `10.0.1.0/24` |
| `proxy_private_ip` | Proxy private IP | `10.0.1.1` |
| `backend_private_ip` | Backend private IP | `10.0.1.2` |

## Tear Down

```bash
terraform destroy
```
