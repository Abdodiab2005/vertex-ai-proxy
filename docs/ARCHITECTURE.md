# Architecture

The gateway is a pnpm monorepo. `apps/api` is the NestJS process. `apps/admin` is
the Next.js control panel. Shared packages hold entities, types, and small
utilities. Clients call `/v1beta`. Operators use the admin origin. Postgres is
the system of record. Redis holds short-lived counters and leases.

## Components

### `apps/api`

NestJS 12 ESM. It serves the public Gemini-compatible API, the admin REST API,
health checks, and `/metrics`.

| Module                          | Role                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-api`                    | `/v1beta/models` list/get and `:generateContent`, `:streamGenerateContent`, `:countTokens`, `:embedContent`, `:batchEmbedContents`. Gemini error filter. |
| `api-keys`                      | Key material, public-API guard, admin CRUD, presets, bulk create, credit operations.                                                                     |
| `credits`                       | Ledger, Redis reservations, usage settlement.                                                                                                            |
| `pricing`                       | BigInt cost engine and snapshots.                                                                                                                        |
| `models`                        | Registry, aliases, pricing rules, sync, route edits, `ModelResolver`.                                                                                    |
| `routing`                       | Route plan (priority / round-robin / manual / fallback) and retry policy.                                                                                |
| `upstreams`                     | Vertex AI provider, credential encrypt/decrypt, Test Connection.                                                                                         |
| `rate-limits`                   | Redis request/token windows and concurrency leases.                                                                                                      |
| `settings`                      | Typed settings, availability guard, spend guard.                                                                                                         |
| `request-logs`                  | Metadata-only log writer, admin list/CSV, hourly retention purge.                                                                                        |
| `audit`                         | Admin/security audit writer and viewer (secret redaction on read).                                                                                       |
| `admin-auth`                    | Login, sessions, CSRF, password change.                                                                                                                  |
| `admin-dashboard`               | Overview summary.                                                                                                                                        |
| `analytics`                     | Usage totals, breakdowns, CSV, timeseries.                                                                                                               |
| `security`                      | Argon2id hasher, admin login rate limiter.                                                                                                               |
| `observability`                 | Request ids, JSON/pretty logger, HTTP access log.                                                                                                        |
| `metrics`                       | In-process Prometheus registry.                                                                                                                          |
| `config` / `database` / `redis` | Env, TypeORM, ioredis.                                                                                                                                   |
| `cli`                           | `create-owner` bootstrap.                                                                                                                                |

Public JSON bodies are limited to `PUBLIC_MAX_REQUEST_BODY_BYTES` (default 20
MiB). Every other route uses `ADMIN_MAX_REQUEST_BODY_BYTES` (default 1 MiB).
Helmet is enabled. There is no response-compression middleware, so SSE is not
held in a gzip buffer.

### `apps/admin`

Next.js on port 3001. Pages: `/login`, `/dashboard`, `/usage`, `/upstreams`,
`/models`, `/api-keys`, `/audit-log`, `/settings`, `/request-logs`. The browser
calls this origin only. Server-side loads use `GATEWAY_API_URL`. Browser
mutations go to `/admin-api/*`, which the Next server forwards to the API's
`/admin/*`.

### Packages

| Package              | Role                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@gateway/database`  | TypeORM entities, migrations, data source. Built to `dist/`.                                                                       |
| `@gateway/contracts` | Closed enums (`ApiKeyStatus`, `CreditTransactionType`) and open string vocabularies (providers, auth methods, billing dimensions). |
| `@gateway/shared`    | Env helper and AES-256-GCM `CredentialCipher`.                                                                                     |

## Public request pipeline

`GatewayAvailabilityGuard` and `ApiKeyAuthGuard` run first on every `/v1beta`
route. Kill switch, `gateway.enabled`, and maintenance reject before a key
lookup. Then the generation path (`PublicGenerationService.prepare` + call +
`settle`) is:

1. **Availability guard** — kill switch → `503 UNAVAILABLE` "The gateway is
   temporarily disabled."; `gateway.enabled` off → "The gateway is disabled.";
   maintenance → the configured maintenance message.
2. **Key auth** — `x-goog-api-key`, else `?key=`. Format `lvg_` + 32 base62.
   SHA-256 lookup. Revoked / expired / suspended / `credit_exhausted` and IP
   allow/block lists are applied here. Endpoint allow-lists are checked next
   (`assertEndpointAllowed`).
3. **Validation** — body must be a JSON object. `generateContent` /
   `streamGenerateContent` require a non-empty `contents` array with `parts`.
   `cachedContent` is rejected. `generationConfig.maxOutputTokens`, when
   present, must be a positive integer. Streaming without `alt=sse` is
   `400 INVALID_ARGUMENT` ("Only alt=sse streaming is supported.").
4. **Model resolution + route plan** — public name or alias; disabled /
   unavailable / no usable route → `404`. `assertModelAllowed`. Capability
   flags must match the action (text, streaming, embeddings). The route plan
   orders upstreams (`priority`, `round_robin` via Redis
   `routing:{modelId}:round-robin`, `manual`, `fallback`).
5. **Media checks** — inline and `fileData` parts are checked against model
   capabilities, Vertex MIME lists, strict standard base64, and
   `media.maxInlineBytes` (default 15 MiB decoded). A part with `inlineData`
   or `fileData` and no `mimeType` is `400`. `fileData` is rejected while
   `media.allowFileUris` is off (the default) — a `gs://` URI would be read
   with the gateway's own Vertex credentials. Failures are `400` before any
   limit, slot, or credit is spent. Nothing is written to disk.
6. **Rate limits** — Redis Lua windows: requests/min, requests/day,
   tokens/min, tokens/day, tokens/month. Rejection is `429 RESOURCE_EXHAUSTED`
   with `Retry-After`.
7. **Concurrency slot** — Redis lease, 10 minutes. A heartbeat every 5 minutes
   extends the slot and the credit hold for streams, unary calls, and
   `batchEmbedContents` until they finish. Rejection is `429` "Too many
   concurrent requests for this API key."
8. **Spend guard** — if `spend.blockWhenThresholdReached` is on and tracked
   `cost_consumed` spend has reached (budget − safety reserve), `503
UNAVAILABLE` "The gateway's spending limit has been reached."
9. **Reservation** — billed actions are `generateContent`,
   `streamGenerateContent`, `embedContent`, and `batchEmbedContents`. Estimate
   from pricing rules (see [`BILLING_AND_CREDITS.md`](./BILLING_AND_CREDITS.md)).
   Missing `input_tokens`/`output_tokens` (or `input_tokens` for embeddings) is
   `400 FAILED_PRECONDITION`. A batch embed takes one hold for the sum of the
   items' input-only estimates. A Redis hold is taken for the estimate (or the
   remaining balance for a lone request). After a successful reserve the
   balance is read again; if active holds no longer fit, the new hold is
   released and the request is refused the same way. Refusal is `429` "API
   key credit has been exhausted." `countTokens` skips this step.
10. **Upstream call with fallback** — the JSON body is forwarded for
    `generateContent` / streaming. When the client omits
    `generationConfig.maxOutputTokens`, the gateway sets it to the output
    tokens the hold covers (the model's `outputTokenLimit`, or 8192). A
    client-supplied value is left unchanged unless it exceeds that limit, in
    which case it is lowered to it. `countTokens` and `embedContent` are
    translated to Vertex's request shapes. `batchEmbedContents` sends each item
    through that embed translation, in order. On the last upstream in the
    plan, a Vertex capacity 429 or a connection that was never established is
    retried after about 1 s, 2 s and 4 s (neither is billed; backoff is Google's
    documented remedy for the 429). Fallback tries the next upstream
    only after a retryable failure that reached nobody (a connection that was
    never established, quota, 5xx; a reset after the request was sent is not
    retried, since Vertex may have accepted and billed it),
    at most three attempts on `fallback`, and never after the first streamed
    byte. The reservation is made once; only the upstream that answered is
    billed.
11. **Usage settlement** — quantities from `usageMetadata` (or embedding
    input tokens). Cost from the pricing engine. A `usage_records` row, a
    `cost_consumed` debit when the cost is known and positive, then the
    reservation and concurrency slot are released. Token counters are updated
    on success/partial.
12. **Request log** — one metadata row (`request_id`, key, model, endpoint,
    status, latency, token totals, cost, client IP, user agent, upstream name,
    error code). No prompt or response body.

Client disconnect aborts the upstream (`AbortController` on response `close`).
`x-request-id` on the response is the same id stored on the usage record and
request log.

## Streaming lifecycle

`POST /v1beta/models/{model}:streamGenerateContent?alt=sse` pipes the upstream
`ReadableStream` to the client. Headers: `Content-Type: text/event-stream`,
`Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
`X-Accel-Buffering: no`. Settlement runs before the response ends. Full
lifecycle (completion, client disconnect, upstream error, idle timeout,
nginx) is in [`streaming.md`](./streaming.md).

## Data model

| Table                 | Holds                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `admin_users`         | Owner email and Argon2id password hash.                                          |
| `admin_sessions`      | SHA-256 of the session token, expiry, revoke time, IP, user agent.               |
| `api_keys`            | Name, `key_prefix`, `key_hash`, status, limits, IP/model/endpoint lists, expiry. |
| `key_presets`         | Named defaults copied onto new keys.                                             |
| `credit_transactions` | Append-only ledger. Balance is the sum of this table.                            |
| `usage_records`       | Per-request accounting: quantities, cost, `cost_undetermined`, pricing snapshot. |
| `usage_aggregates`    | Hour/day/month counter table. Dashboard and usage views query `usage_records`.   |
| `models`              | Public name, upstream name, capabilities, token limits, default upstream.        |
| `model_aliases`       | Unique aliases → model.                                                          |
| `model_routes`        | Extra upstreams, priority, strategy, enabled.                                    |
| `pricing_rules`       | Effective-dated unit price per billing dimension.                                |
| `upstreams`           | Vertex project, location, auth method, encrypted credentials, probe status.      |
| `request_logs`        | Metadata-only public-request log. No content columns.                            |
| `audit_logs`          | Admin/security actions with `before`/`after` snapshots.                          |
| `system_settings`     | Key/value settings (kill switch, limits, timeouts, spend, retention).            |

Money columns are Postgres `numeric`. TypeScript carries them as strings.

## Redis

| Key                                                               | Use                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| `ratelimit:{apiKeyId}:rpm:…` / `rpd:` / `tpm:` / `tpd:` / `tpmo:` | Request and token windows (Redis `TIME`, UTC).         |
| `ratelimit:{apiKeyId}:concurrency`                                | Concurrency zset of lease members.                     |
| `credit:zset:{apiKeyId}` + `credit:hash:{apiKeyId}`               | In-flight reservation ids, expiry, micro-unit amounts. |
| `routing:{modelId}:round-robin`                                   | Round-robin counter.                                   |
| `admin-login:fail:account-ip:…` / `account:` / `ip:`              | Admin login failure counters.                          |

Losing Redis is safe. The ledger and key rows are in Postgres. Missing Redis
keys only reset throttles, login counters, round-robin position, and in-flight
holds (without a heartbeat they expire within 10 minutes). Admin login fails closed with
`503` if Redis is unreachable during login.

## Admin panel and API

The browser origin is the admin host. It never calls the API origin.

- Server components load through `GATEWAY_API_URL` + `/admin/…` (cookie
  forwarded).
- Browser mutations `fetch('/admin-api/…')`.
- `apps/admin/src/app/admin-api/[...path]/route.ts` forwards to
  `{GATEWAY_API_URL}/admin/{path}` with `cookie`, `content-type`,
  `x-csrf-token`, `user-agent`, and `x-forwarded-for`. `Set-Cookie` is copied
  back.

Public nginx vhosts do not proxy `/admin`. On a single hostname, `/admin` is
refused; the panel still reaches the API on the Docker network.

## Observability

- **Request ids.** `requestIdMiddleware` always generates a UUID; it is returned
  as `x-request-id` and keys the usage and request-log rows. A caller's own
  `x-request-id` (matching `^[A-Za-z0-9._-]{8,128}$`) is only logged, as
  `clientRequestId` in the access log: letting callers choose the unique key
  would let a reused id make settlement fail after the response was sent.
- **Logs.** `LOG_FORMAT` is `pretty` outside production and `json` in
  production when unset. Access events are `http_request` with `requestId`,
  `method`, `path` (query string stripped), `status`, `durationMs`, and
  optional `apiKeyPrefix`. Structured metadata keys `authorization`, `body`,
  `cookie`, `headers`, `query`, and `rawbody` are dropped.
- **`/metrics`.** Prometheus text. Requires `Authorization: Bearer
<METRICS_TOKEN>` (timing-safe compare). Unset token → `404`. Counters cover
  HTTP requests/duration, in-flight public requests and streams, upstream
  failures, credit rejections, and rate-limit rejections. Process-local;
  restart resets them.
- **Health.** `GET /health/live` → `{ status: "alive" }` with no dependency
  check. `GET /health/ready` → Postgres `SELECT 1` and Redis `PING`, else
  `503` `{ status: "not_ready" }`. `GET /health` → `200` `{ status: "ok" }` or
  `503` `{ status: "degraded" }` with which dependency failed.

See also [`DEPLOYMENT.md`](./DEPLOYMENT.md) and [`../README.md`](../README.md).
