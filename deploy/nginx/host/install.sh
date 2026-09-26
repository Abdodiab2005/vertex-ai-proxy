#!/bin/sh
# Renders the host nginx sites for the host-proxy deployment and reloads nginx.
#   sudo sh deploy/nginx/host/install.sh <public-domain> <admin-domain> [api-port] [admin-port]
# Then issue certificates: sudo certbot --nginx -d <public-domain> -d <admin-domain>
set -eu

public_domain="$1"
admin_domain="$2"
api_port="${3:-3830}"
admin_port="${4:-3831}"
here="$(cd "$(dirname "$0")" && pwd)"

render() {
  sed -e "s/__PUBLIC_DOMAIN__/$public_domain/g" -e "s/__ADMIN_DOMAIN__/$admin_domain/g" \
      -e "s/__API_PORT__/$api_port/g" -e "s/__ADMIN_PORT__/$admin_port/g" "$1"
}

mkdir -p /etc/nginx/snippets
cp "$here/api-proxy.snippet.conf" /etc/nginx/snippets/ai-proxy-api-proxy.conf

# Cloudflare publishes its ranges; fetching them keeps the real-IP list current.
{
  echo "# Cloudflare edge ranges, fetched $(date -u +%Y-%m-%d). Re-run install.sh to refresh."
  for range in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do
    echo "set_real_ip_from $range;"
  done
  echo "real_ip_header CF-Connecting-IP;"
} > /etc/nginx/snippets/cloudflare-real-ip.conf

# certbot edits these files in place (TLS listener, certificate paths); overwriting them would drop
# that, so existing sites are kept. Delete a file first to render it again, then re-run certbot.
for pair in "public.conf.template:$public_domain" "admin.conf.template:$admin_domain"; do
  target="/etc/nginx/conf.d/${pair#*:}.conf"
  if [ -e "$target" ]; then
    echo "Keeping existing $target"
  else
    render "$here/${pair%%:*}" > "$target"
  fi
done

nginx -t
systemctl reload nginx
echo "Installed $public_domain -> 127.0.0.1:$api_port and $admin_domain -> 127.0.0.1:$admin_port"
