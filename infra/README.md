# Euro-Office Infrastructure (Hetzner PoC)

Single-VM deployment of Euro-Office Document Server on Hetzner Cloud with automatic TLS via Caddy.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- A Hetzner Cloud account + API token (Project → Security → API Tokens)
- A domain with DNS you control (point an A record at the server IP after deploy)
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
1. Note the `server_ipv4` output
2. Point your domain's A record to that IP
3. Wait 1-2 minutes for Docker to pull the image and Caddy to obtain a TLS cert
4. Visit `https://your-domain.com` — the example app should be live

## Architecture

```
Internet → Caddy (TLS termination, :443) → Document Server (:80 internal)
```

Everything runs on a single VM via Docker Compose:
- **Caddy** — reverse proxy with automatic Let's Encrypt
- **Document Server** — Euro-Office all-in-one image (nginx, node, postgres, redis, rabbitmq inside)

## SSH Access

```bash
ssh root@<server-ip>
```

Logs:
```bash
cd /opt/euro-office && docker compose logs -f
```

## Variables

| Name | Description | Default |
|------|-------------|---------|
| `hcloud_token` | Hetzner API token | — |
| `ssh_public_key` | Your SSH public key | — |
| `domain` | Domain for TLS | — |
| `jwt_secret` | Document Server JWT secret | — |
| `acme_email` | Let's Encrypt notification email | — |
| `server_type` | Hetzner VM size | `cx31` |
| `location` | Hetzner datacenter | `fsn1` |

## Tear Down

```bash
terraform destroy
```
