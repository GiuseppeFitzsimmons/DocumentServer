output "server_ipv4" {
  description = "Public IPv4 address of the Euro-Office server"
  value       = hcloud_server.euro_office.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the Euro-Office server"
  value       = hcloud_server.euro_office.ipv6_address
}

output "url" {
  description = "Euro-Office URL"
  value       = "http://${hcloud_server.euro_office.ipv4_address}"
}

output "ssh_command" {
  description = "SSH into the server"
  value       = "ssh root@${hcloud_server.euro_office.ipv4_address}"
}

output "proxy_ipv4" {
  description = "Public IPv4 address of the proxy server"
  value       = hcloud_server.proxy.ipv4_address
}

output "proxy_ssh" {
  description = "SSH into the proxy server"
  value       = "ssh root@${hcloud_server.proxy.ipv4_address}"
}
