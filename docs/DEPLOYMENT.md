# Deployment

Production runs the API, the admin panel, Postgres, Redis, and nginx, plus a one-shot migration container. Images are built from this repository. Nothing in the image contains a secret; the operator supplies `deploy/.env` and TLS files at runtime.

Commands below are run from the repository root.

## Prerequisites

- Docker Engine with Compose v2.
- A host that can bind ports 80 and 443.
- DNS names for the public API and, in the two-domain layout, the admin panel.
- `openssl` for generating secrets and, if you need one, a short-lived self-signed certificate.

Node and pnpm are not required on the host. The images install pnpm 12.6.0 (the version in the root `package.json` `packageManager` field) and build inside the container.

## Generate secrets

```bash
openssl rand -base64 32   # CREDENTIALS_ENCRYPTION_KEY (32 bytes, base64)
openssl rand -base64 32   # DB_PASSWORD
openssl rand -base64 24   # METRICS_TOKEN (set it only if you will scrape /metrics)
```

`CREDENTIALS_ENCRYPTION_KEY` must decode to exactly 32 bytes. `METRICS_TOKEN`, when set, must be at least 16 characters. Use a database password that is not the `changeme` placeholder in `.env.example`.

## Configure `deploy/.env`

```bash
cp .env.example deploy/.env
```

Edit `deploy/.env`. Compose reads that file for `${...}` substitution. The API and the migrate container also load it as their `env_file`. The admin container does not: it only receives `GATEWAY_API_URL`, so the database password and the encryption key are not in that process. Do not export a shell variable that disagrees with the file. A shell variable of the same name wins substitution, and Postgres would then use a different password from the one you think you set.

The production compose file overrides a few values so a copied development file still works on the Docker network:

| Variable          | Forced value                           | Why                                                         |
| ----------------- | -------------------------------------- | ----------------------------------------------------------- |
| `NODE_ENV`        | `production`                           | Cookie `Secure`, JSON logs, production error behavior       |
| `PORT`            | `3000` on the API, `3001` on the panel | nginx upstreams                                             |
| `DB_HOST`         | `postgres`                             | Service DNS name, not the host's localhost                  |
| `REDIS_URL`       | `redis://redis:6379`                   | Bundled Redis has no password and is not published          |
| `TRUST_PROXY`     | `172.28.0.0/16`                        | The compose network CIDR. See [TRUST_PROXY](#trust_proxy)   |
| `GATEWAY_API_URL` | `http://api:3000`                      | The panel's server-side origin. Browsers never call the API |
| `DB_SSL`          | value from `deploy/.env`, or `false`   | The bundled Postgres image speaks plain TCP                 |

`NGINX_SITE` is not an application variable. Set it to `two-domain.conf` (the default) or `single-domain.conf`.

## Environment variables

Every variable in `.env.example` is listed below. Required means the API process refuses to start without a valid value. Defaults are the application defaults from the zod schemas, before the compose overrides above. Blank (`LOG_FORMAT=`, `METRICS_TOKEN=`, `ADMIN_COOKIE_SECURE=`, `LOG_INCLUDE_STACK=`) means unset.

| Variable                                  | Required | Default                                           | Description                                                                                                |
| ----------------------------------------- | -------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `DB_HOST`                                 | no       | `localhost`                                       | Postgres host                                                                                              |
| `DB_PORT`                                 | no       | `5432`                                            | Postgres port                                                                                              |
| `DB_USERNAME`                             | no       | `postgres`                                        | Postgres user                                                                                              |
| `DB_PASSWORD`                             | yes      |                                                   | Postgres password. No default; boot fails if it is missing                                                 |
| `DB_NAME`                                 | no       | `gemini_gateway`                                  | Database name                                                                                              |
| `DB_SSL`                                  | no       | `false`                                           | `true` or `false`. Enables TLS for the Postgres connection                                                 |
| `REDIS_URL`                               | no       | `redis://localhost:6379`                          | Redis URL used for rate limits, concurrency leases, credit reservations, and admin login throttles         |
| `NODE_ENV`                                | no       | `development`                                     | `development`, `test`, or `production`                                                                     |
| `PORT`                                    | no       | `3000`                                            | API listen port                                                                                            |
| `PUBLIC_MAX_REQUEST_BODY_BYTES`           | no       | `20971520`                                        | JSON body limit for `/v1beta` (20 MiB)                                                                     |
| `ADMIN_MAX_REQUEST_BODY_BYTES`            | no       | `1048576`                                         | JSON body limit for the admin API and every other route (1 MiB)                                            |
| `TRUST_PROXY`                             | no       | `loopback`                                        | Express `trust proxy` value. `true`, `false`, a hop count, or a string such as a CIDR. See below           |
| `LOG_FORMAT`                              | no       | `pretty` outside production, `json` in production | `json` or `pretty`                                                                                         |
| `LOG_INCLUDE_STACK`                       | no       | `false`                                           | `true` or `false`. Include stack traces in structured logs                                                 |
| `METRICS_TOKEN`                           | no       | unset, `/metrics` returns 404                     | Bearer token for `/metrics`. At least 16 characters when set                                               |
| `SHUTDOWN_GRACE_MS`                       | no       | `15000`                                           | On SIGTERM, how long in-flight requests may finish before they are cancelled and settled                   |
| `ADMIN_LOGIN_WINDOW_SECONDS`              | no       | `900`                                             | Window for failed admin login attempts                                                                     |
| `ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT_IP` | no       | `5`                                               | Failed logins for one account from one IP                                                                  |
| `ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT`    | no       | `50`                                              | Failed logins for one account from any IP                                                                  |
| `ADMIN_LOGIN_MAX_FAILURES_PER_IP`         | no       | `20`                                              | Failed logins from one IP across accounts                                                                  |
| `ADMIN_SESSION_TTL_HOURS`                 | no       | `12`                                              | Admin session lifetime in hours, from 1 to 720                                                             |
| `ADMIN_COOKIE_SECURE`                     | no       | secure when `NODE_ENV` is `production`            | `true` or `false`. Unset follows `NODE_ENV`                                                                |
| `CREDENTIALS_ENCRYPTION_KEY`              | yes      |                                                   | 32-byte key, base64 or base64url, used to encrypt upstream credentials. No default                         |
| `GATEWAY_API_URL`                         | no       | `http://localhost:3000`                           | Origin the admin server uses to reach the API. Read when the panel process starts. Not sent to the browser |

The API schema also accepts `NODE_ENV=test`. Production compose sets `production`.

## TLS

Put the certificate chain and key here:

```
deploy/certs/fullchain.pem
deploy/certs/privkey.pem
```

Both nginx server blocks read those paths. In the two-domain layout the certificate must include `gemini.example.com` and `admin-gemini.example.com`, or you edit the admin server's `ssl_certificate` lines to a second pair. Replace the `server_name` values in the file you select (`deploy/nginx/two-domain.conf` or `deploy/nginx/single-domain.conf`).

Protocols are TLS 1.2 and TLS 1.3. Port 80 redirects to HTTPS, except `/.well-known/acme-challenge/`, which is served from `/var/www/certbot` inside the nginx container. Mount a webroot there if you complete HTTP-01 challenges on this host:

```yaml
# under the nginx service
volumes:
  - ./certbot:/var/www/certbot:ro
```

A self-signed certificate is enough to prove the stack starts:

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 30 -nodes \
  -keyout deploy/certs/privkey.pem \
  -out deploy/certs/fullchain.pem \
  -subj "/CN=gemini.example.com" \
  -addext "subjectAltName=DNS:gemini.example.com,DNS:admin-gemini.example.com"
```

Those files match `.gitignore` (`*.pem`, `*.key`). Leave them uncommitted.

## First deploy

1. Create `deploy/.env` and `deploy/certs` as above. Edit `server_name` (and, if needed, the certificate paths) in the nginx file you will use.
2. Build and start. The `migrate` service runs the compiled TypeORM migrations after Postgres is healthy, and the API does not start until that container exits 0.

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

3. Create the first admin. The command works only while `admin_users` is empty. With `-T` there is no TTY, so the first line of stdin is the password (there is no confirmation prompt).

```bash
printf '%s\n' 'replace-with-a-real-password' | docker compose -f deploy/docker-compose.prod.yml run --rm -T api \
  node /app/dist/cli/create-owner.js --email owner@example.com
```

On a TTY, omit the pipe and `-T`. The CLI then prompts twice and does not echo the password.

The same image can run migrations by hand:

```bash
docker compose -f deploy/docker-compose.prod.yml run --rm migrate
```

That executes:

```
node /app/node_modules/typeorm/cli.js migration:run \
  -d /app/node_modules/@gateway/database/dist/data-source.js
```

The data source is the compiled `@gateway/database` build. It reads `DB_*` from the environment. It does not need `CREDENTIALS_ENCRYPTION_KEY`.

## Upgrades

Build the new images, then recreate the stack. `--force-recreate` runs the one-shot migrate container again; without it, a migrate container that already exited 0 is left as-is and new migrations would not run. Named volumes are kept.

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build --force-recreate
```

The API waits until migrate exits 0. Roll back by checking out the previous revision and running the same command. Do that only when the migrations that already ran are still compatible with the previous code. This repository's migrations are forward-only; a migration that dropped a column cannot be undone by restarting an old image. Restore a database dump instead.

## TRUST_PROXY

nginx sets `X-Forwarded-For` and `X-Forwarded-Proto` on every proxied request. The API copies the Express `trust proxy` setting from `TRUST_PROXY`, and `req.ip` is what API-key IP allow and block lists, admin login throttles, and audit records use.

`loopback` (the development default) does not trust the Docker bridge. Every client would show up as the nginx container, or as the admin container for requests the panel forwards. Production compose sets `TRUST_PROXY=172.28.0.0/16`, the `gateway` network subnet in `deploy/docker-compose.prod.yml`. Express then trusts the hop it actually received the connection from and uses the client address nginx appended.

Do not set `TRUST_PROXY=true`. That trusts a forwarded header from any peer, so a caller who can reach the API can pick their own address. The API port is not published, but the panel forwards the incoming `X-Forwarded-For`, and a forged prefix is possible. The CIDR makes Express stop at the address nginx added.

If you change the subnet, change `TRUST_PROXY` in the compose file to the same CIDR. If you put another proxy in front of nginx, nginx must be the one that appends the real client address (its own `real_ip` configuration), and `TRUST_PROXY` must still be only the Docker network, not the public proxy's range.

`ADMIN_COOKIE_SECURE` defaults to on in production. The browser talks to nginx over HTTPS, and the panel forwards the API's `Set-Cookie`. Serve the admin host over HTTPS or the browser will drop the session cookie.

## Behind an existing host nginx

On a server whose own nginx already serves other sites on 80/443, leave the bundled nginx out and let
the host nginx route the two domains to loopback ports:

```bash
# deploy/.env also sets API_HOST_PORT / ADMIN_HOST_PORT (defaults 3830 / 3831) if those are taken.
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.host-proxy.yml up -d --build
sudo sh deploy/nginx/host/install.sh api.example.com admin.example.com 3830 3831
sudo certbot --nginx -d api.example.com -d admin.example.com
```

`install.sh` renders the two sites into `/etc/nginx/conf.d/` (public domain: `/v1beta` and `/health`
only, streaming-safe, access log without query strings; admin domain: the panel), writes the proxy
snippet and a Cloudflare real-IP snippet (fetched from Cloudflare's published ranges), then tests
and reloads nginx. It never overwrites an existing site file, because certbot has edited it; delete
the file to render it again and re-run certbot. The containers are reached through the Docker
network gateway, which the compose file's `TRUST_PROXY` already trusts, so per-IP limits see the
client address nginx forwards.

## Graceful shutdown

On SIGTERM (`docker compose stop`, a redeploy) the API stops admitting public requests (they get `503 UNAVAILABLE` and `/health/ready` fails), lets requests in flight finish for up to `SHUTDOWN_GRACE_MS`, then cancels the rest. Cancelled requests are still settled: a stream is billed for the usage it reported so far and ends with a `503 UNAVAILABLE` error event, and every concurrency slot and credit reservation is released. The compose file gives the API `stop_grace_period: 30s`; if you raise `SHUTDOWN_GRACE_MS`, raise that too (grace + 5 s to settle + a margin).

## Health, readiness, and metrics

| Path                | Meaning                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | The process is serving. No dependency check. The image `HEALTHCHECK` uses this so a Redis or Postgres blip does not restart the container            |
| `GET /health/ready` | Postgres answers `SELECT 1` and Redis answers `PING`. `503` with `status: not_ready` otherwise                                                       |
| `GET /health`       | Same checks. `200` with `status: ok`, or `503` with `status: degraded` and which dependency failed                                                   |
| `GET /metrics`      | Prometheus text. Requires `Authorization: Bearer <METRICS_TOKEN>`. Missing or wrong token is `401`. Unset `METRICS_TOKEN` disables the route (`404`) |

nginx publishes `/health` and `/health/*` on the public host. It does not publish `/metrics`. Scrape `http://api:3000/metrics` from inside the `gateway` network, or add a location yourself. Keep the token out of the public vhost.

## Backups

Postgres holds accounts, credentials (encrypted), the credit ledger, models, and request metadata. Dump it from outside the database container, and copy the dump off this machine. A file that only exists on the same disk is not a backup. Encrypt the dump, and keep at least one weekly copy and one monthly copy in addition to the nightly one. How often you dump is how much ledger history you can lose.

```bash
docker compose -f deploy/docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' \
  > "gateway-$(date +%F).dump"
```

Restore into a database you can throw away first, and time it. Before restoring over the live database, stop the API and admin so they are not writing:

```bash
docker compose -f deploy/docker-compose.prod.yml stop api admin
docker compose -f deploy/docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < gateway-YYYY-MM-DD.dump
docker compose -f deploy/docker-compose.prod.yml start api admin
```

`--clean` drops objects before recreating them. Confirm the dump's timestamp before you run it.

Redis stores rate-limit counters, concurrency leases, and in-flight credit reservations. AOF is on, so a container restart keeps them. Losing the dataset is safe: the credit ledger is in Postgres, and the missing keys only reset throttles and in-flight reservations. Do not treat a Redis snapshot as a backup of accounts or balances.

## Rotating `CREDENTIALS_ENCRYPTION_KEY`

There is no re-encryption tool. Each stored credential is `v1.<key id>.<iv>.<ciphertext>.<tag>`. Decryption rejects a payload whose key id does not match the current key, so the process cannot read credentials written by the previous key.

Rotation means the old ciphertext becomes unreadable. Plan on re-entering every upstream credential from your own copy of the service-account JSON or API key:

1. Generate a new key with `openssl rand -base64 32`.
2. Put it in `deploy/.env` and recreate the API: `docker compose -f deploy/docker-compose.prod.yml up -d --force-recreate api`.
3. In the admin panel, open each upstream and save the credential again so it is encrypted with the new key.
4. Call the upstream connection test before you discard the previous key's written-down copy. You cannot recover the previous ciphertext by putting the old key back after you have overwritten a row, and you cannot read the old row while the new key is in the environment.

Keep the key with your other secrets, not in the database backup's only storage location. A dump without the key still restores the ledger, and the upstreams need their credentials entered again.

## Access logs and API keys

nginx access logs must never record request query strings because public clients may authenticate using `?key=<api-key>`. The site configurations define a custom `log_format` using `$uri` instead of `$request` or `$request_uri`, logging the HTTP method, normalized URI path, protocol, status, bytes, request time, and `X-Request-ID` without query parameters. Gateway API keys carry full authorization and billing permissions; logging them in plaintext exposes credentials to anyone with access to access logs or log aggregation pipelines.

The nginx error log is different: when a request fails at the proxy (for example the API is down), nginx writes the full request line, query string included, and no directive strips it. Tell clients to send the key in the `x-goog-api-key` header, which never appears in either log, and treat the error log as sensitive.

## What never gets committed

`.gitignore` already excludes `.env` (but not `.env.example`), `*.pem`, `*.key`, `service-account*.json`, and `credentials*.json`. The Docker build context excludes the same patterns, so a secret file sitting in the checkout is not copied into an image layer. Do not pass secrets as `docker build` arguments. Do not commit a filled-in `deploy/.env`, a database dump, or a service-account file an upstream was configured with.

## Layout

| Path                              | Role                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `docker/api.Dockerfile`           | Multi-stage API image. Runtime is `node dist/main.js` as the `node` user            |
| `docker/admin.Dockerfile`         | Multi-stage admin image. Runtime is the Next.js standalone `server.js` on port 3001 |
| `deploy/docker-compose.prod.yml`  | postgres, redis, migrate, api, admin, nginx                                         |
| `deploy/nginx/two-domain.conf`    | `gemini.example.com` for the API, `admin-gemini.example.com` for the panel          |
| `deploy/nginx/single-domain.conf` | One host. `/v1beta` and `/health` go to the API, `/` to the panel                   |
| `deploy/nginx/proxy-api.inc`      | Streaming proxy settings for every API location                                     |
| `deploy/nginx/select-site.sh`     | Copies `NGINX_SITE` into nginx's conf.d and execs nginx                             |
| `deploy/certs/`                   | `fullchain.pem` and `privkey.pem`, supplied by you                                  |

The dev compose file at the repository root publishes Postgres and Redis on the host and is not this stack. Its volumes are a different Compose project.
