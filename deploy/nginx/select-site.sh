#!/bin/sh
# Selects the vhost file. This lives in the mounted config directory so the
# shell can read $NGINX_SITE: a dollar sign inside the compose `command` string
# is consumed by Compose interpolation before the container starts.
set -eu

case "$NGINX_SITE" in
  two-domain.conf|single-domain.conf) ;;
  *)
    echo "NGINX_SITE must be two-domain.conf or single-domain.conf" >&2
    exit 1
    ;;
esac

rm -f /etc/nginx/conf.d/default.conf
cp "/etc/nginx/gateway/$NGINX_SITE" /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
