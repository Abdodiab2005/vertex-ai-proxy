# Security

## Admin authentication

Passwords are hashed with Argon2id via `@node-rs/argon2`:

| Parameter   | Value      |
| ----------- | ---------- |
| Algorithm   | Argon2id   |
| Version     | `0x13`     |
| Memory      | 19,456 KiB |
| Time cost   | 2          |
| Parallelism | 1          |
| Hash length | 32 bytes   |

New passwords must be 12–256 characters (`pnpm admin:create-owner` and
password change). Login of an unknown email still runs a dummy verify so the
timing stays close to a known account.

Sessions: 32 random bytes, base64url, in the HttpOnly, SameSite=Strict,
`Path=/` cookie `gw_admin_session`. `Secure` is on when `NODE_ENV` is
`production`, or when `ADMIN_COOKIE_SECURE` is set. Only SHA-256 of the token
is stored. Absolute TTL is `ADMIN_SESSION_TTL_HOURS` (default 12, max 720).
Logout and password change revoke sessions (password change keeps the current
one). Disabled users cannot resolve a session.

CSRF: `x-csrf-token` is SHA-256 of `csrf:` + the raw session token, encoded
base64url. Login returns it in the JSON body. `GET /admin/auth/me` returns it
for the signed-in panel. POST, PUT, PATCH, and DELETE on admin routes require
a timing-safe match. GET does not.

Login rate limiting is in Redis (window `ADMIN_LOGIN_WINDOW_SECONDS`, default
900s):

- 5 failures per account+IP (`ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT_IP`)
- 50 failures per account (`ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT`)
- 20 failures per IP (`ADMIN_LOGIN_MAX_FAILURES_PER_IP`)

While limited, login returns `429` with `Retry-After`, including a correct
password. If Redis is unreachable during check, record, or clear, login
returns `503` "Login is temporarily unavailable."

Helmet is enabled on the API.

## API keys

Format: `lvg_` + 32 characters from
`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`, generated
with rejection sampling. Stored fields are SHA-256 hex of the full raw key
and the first 12 characters (`lvg_` + 8) as `keyPrefix`. The raw key is
returned once on create, regenerate, and bulk create (plus a one-time CSV for
bulk). It is not persisted.

Auth accepts `x-goog-api-key` or `?key=`; the header wins. Status values:
`active`, `suspended`, `revoked`, `expired`, `credit_exhausted`.

## Upstream credential encryption

`fileData` parts are rejected unless `media.allowFileUris` is turned on. With
a service account or ADC, a `gs://` URI is read as the gateway's own identity,
and the object's size cannot be held in advance. When the setting is on, each
file URI reserves `media.fileUriHoldTokens` (default 50000).

`CredentialCipher` uses AES-256-GCM. `CREDENTIALS_ENCRYPTION_KEY` is 32 bytes
as base64 or base64url; boot fails without it. Each payload is
`v1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url segments). `keyId` is the
first 16 hex characters of SHA-256 of the raw key. IV is 12 random bytes. AAD
is `upstream:{upstreamId}`, so a ciphertext copied onto another row will not
decrypt.

The admin API is write-only for credentials. Views expose `hasCredentials`
and `credentialSummary` (service-account `client_email`; API keys have no
summary). There is no re-encryption tool. Rotating the key makes old rows
unreadable; re-enter each upstream credential. Steps are in
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

## What is never logged

Access logs record `requestId`, `method`, `path` with the query string
stripped, `status`, `durationMs`, and optionally `apiKeyPrefix`. Structured
logger metadata keys `authorization`, `body`, `cookie`, `headers`, `query`,
and `rawbody` are dropped. Audit writers do not store raw keys, passwords, or
credential plaintext; the viewer also redacts keys matching
`pass(word)?|secret|token|private_?key|api_?key|credential|hash`.

## Request log privacy

`request_logs` has no column for prompt or response content. Each
authenticated public request stores request id, api key id, model name,
endpoint, status, latency, token totals, other usage dimensions, calculated
cost, client IP, user agent (truncated to 512 characters), upstream name, and
error code.

Setting `logging.metadataRetentionDays` is 7, 30, 90, or empty (keep until
deleted); default 90. Every hour one API instance (chosen by a Redis lock)
deletes rows older than the retention window, in batches of 5,000.

Content logging (storing prompts and responses) is not available: the
`logging.contentLoggingEnabled` setting is fixed at `false`.

## Trust proxy

`TRUST_PROXY` is passed to Express. `req.ip` feeds API-key IP lists, admin
login throttles, and audit IPs. The development default is `loopback`.
Production compose sets `172.28.0.0/16` (the Docker network CIDR) so the
client address nginx appended is used. `TRUST_PROXY=true` trusts a forwarded
header from any peer. See [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Secrets handling

Do not commit `.env`, `deploy/.env`, `*.pem`, `*.key`, `service-account*.json`,
`credentials*.json`, or database dumps. `.gitignore` already excludes those
patterns (`.env.example` stays tracked). Docker build context excludes them.
Do not pass secrets as `docker build` arguments. Generate
`CREDENTIALS_ENCRYPTION_KEY` with `openssl rand -base64 32`. Keep it with
other secrets, separate from the only copy of a database dump.

## Live run (2026-09-25)

Against real Vertex AI (express-mode API key, `gemini-2.5-flash` and
`gemini-embedding-001`) with `pnpm compat:smoke`, neither the Vertex key nor
the gateway key appeared in the API log or in a `pg_dump` of the database.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`../README.md`](../README.md).
