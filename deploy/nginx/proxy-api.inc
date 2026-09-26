# Included from every location that proxies the API.
#
# Buffering and gzip would hold a streamed body until the upstream finished.
# 21m is above the API's 20 MiB public JSON limit (20971520 bytes) so a too-large
# body reaches the API and is rejected in the Gemini error format, not by nginx.
# Docker recreates containers at new addresses; a variable proxy_pass re-resolves
# api through the embedded DNS instead of caching the IP from process start.
# Cookie is cleared because public routes authenticate with an API key. On the
# single-domain vhost the browser would otherwise send the admin session cookie.

resolver 127.0.0.11 valid=10s ipv6=off;
set $gateway_api_upstream api:3000;
proxy_pass http://$gateway_api_upstream;
proxy_http_version 1.1;
proxy_buffering off;
proxy_cache off;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
client_max_body_size 21m;
gzip off;
proxy_set_header Cookie "";
