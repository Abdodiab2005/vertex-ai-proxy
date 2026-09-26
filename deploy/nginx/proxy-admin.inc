# The admin panel is a Next.js server. It streams RSC responses, so buffering
# stays off. The panel calls the API itself (GATEWAY_API_URL); this vhost must
# not be pointed at the API.
#
# Docker recreates containers at new addresses; a variable proxy_pass re-resolves
# admin through the embedded DNS instead of caching the IP from process start.

resolver 127.0.0.11 valid=10s ipv6=off;
set $gateway_admin_upstream admin:3001;
proxy_pass http://$gateway_admin_upstream;
proxy_http_version 1.1;
proxy_buffering off;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_read_timeout 120s;
proxy_send_timeout 120s;
# Above the API's 1 MiB admin JSON limit so the API, not nginx, answers 413.
client_max_body_size 2m;
