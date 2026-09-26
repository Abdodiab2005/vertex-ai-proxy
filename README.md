# Vertex AI Proxy

**A self-hosted, Gemini-API-compatible gateway in front of Google Vertex AI. Issue your own API keys
with prepaid credit, rate limits and exact per-request billing, and keep using the official Gemini
SDKs unchanged.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%2B-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7%2B-DC382D?logo=redis&logoColor=white)

---

## Why

You have a Google Cloud project with Vertex AI billing or credits. You want apps, teammates or testers
to use Gemini models without handing out Google credentials, without risking an unbounded bill, and
without rewriting clients.

Vertex AI Proxy sits between your clients and Vertex AI:

- Clients call the **Gemini REST API** (`/v1beta/models/...`) with a gateway key, exactly as they would
  call Google. The official `@google/genai` and `google-genai` SDKs work by changing only the base URL.
- Every key has its own **prepaid balance**, limits and model permissions. A request is refused
  **before** Vertex is called when the key cannot pay for it.
- Every response is **billed from the usage Vertex reports**, per token type (input, output, thinking,
  cached, audio, generated images), at prices you configure, into an append-only ledger.
- An **admin panel** manages upstreams, models, prices, keys and credit, and shows usage, logs, audits
  and alerts.

## Features

**Gemini-compatible API**

- `models.list`, `models.get`, `generateContent`, `streamGenerateContent` (SSE), `countTokens`,
  `embedContent`, `batchEmbedContents`
- Text, image, audio, video and PDF input; function calling; system instructions; generation config;
  safety settings; image-generation models
- Authentication with the `x-goog-api-key` header or the `?key=` query parameter; Gemini-shaped error
  bodies and status codes
- Verified against real Vertex AI with the official JavaScript and Python SDKs

**Prepaid credit and billing**

- An append-only credit ledger per key (PostgreSQL `numeric`, BigInt micro-units, never floating point)
- A credit **hold** is reserved before each upstream call and settled to the real cost afterwards, so
  concurrent requests cannot jointly overspend a balance
- Per-dimension pricing with effective dates (schedule a price change in advance), and a pricing
  snapshot on every usage record
- Streams are billed even when the client disconnects early; failed upstream calls are not billed
- An optional global spend guard against your upstream budget

**Access control**

- Keys are shown once and stored as SHA-256 plus a short prefix; expiry, suspend, revoke, regenerate
- Per-key model allow/block lists (aliases included), endpoint lists, IP allow/block lists
- Requests per minute and day, tokens per minute, day and month, and concurrent-request limits
- Key presets and bulk key generation (with a one-time CSV export)

**Upstreams and routing**

- Vertex AI with Application Default Credentials, a service-account key, or an express-mode API key
- Upstream credentials encrypted at rest (AES-256-GCM, bound to their upstream)
- Several upstreams per model (other projects or regions) with priority, round-robin, manual or
  fallback routing
- Automatic retries with backoff for Vertex capacity errors (`429 Resource exhausted`) and for
  connections that never reached Google, but never for a request Vertex may already have billed

**Admin panel and operations**

- Dashboard, usage analytics with CSV export, metadata-only request logs, and an audit log
- Alerts (credit at 80% or exhausted, error rate, upstream failures, spend threshold) with a pluggable
  notification-channel interface
- Global settings: kill switch, maintenance mode, key defaults, timeouts, retention, media limits
- Health and readiness probes, Prometheus metrics, structured JSON logs, request ids
- Graceful shutdown that lets in-flight requests finish, or settles them, before exit
- Production Docker images, Compose files and nginx configurations

## How it works

```text
 Gemini clients / SDKs                          Browser (operators)
        │  x-goog-api-key                              │
        ▼                                              ▼
 ┌──────────────── nginx (TLS, streaming-safe) ────────────────┐
 │  api.example.com: /v1beta, /health     admin.example.com: / │
 └──────────┬───────────────────────────────────────┬──────────┘
            ▼                                       ▼
   ┌─────────────────┐      server-side      ┌─────────────────┐
   │  API (NestJS)   │ ◄──── /admin-api ──── │ Admin (Next.js) │
   └───┬────────┬────┘                       └─────────────────┘
       │        │
       ▼        ▼
  PostgreSQL   Redis                 ─────►  Google Vertex AI
  (keys, ledger,  (rate limits,              (Gemini models)
   usage, logs)    holds, leases)
```

Every public request goes through the same pipeline:

1. **Authenticate** the gateway key and check its status, expiry, IP, endpoint and model permissions.
2. **Validate** the request, including inline media (type, size, and what the model supports).
3. **Resolve** the model (aliases, capabilities) and plan the route across its upstreams.
4. **Admit** it against the key's rate limits and concurrency slots (atomic Redis scripts).
5. **Reserve** an estimated credit hold, sized from the prompt and the output cap, or refuse with `429`
   if the key cannot cover it.
6. **Call Vertex**, retrying or falling back only when it is safe to do so.
7. **Settle** from the `usageMetadata` Vertex returns: write the usage record and the ledger debit,
   release the hold and the slot, and log request metadata (never prompt or response content).

More detail: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Tech stack

| Part        | Technology                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------- |
| API         | NestJS 12 (Node.js, ESM, TypeScript), TypeORM, Zod                                          |
| Admin panel | Next.js 16 (App Router), React 19, Tailwind CSS 4                                           |
| Data        | PostgreSQL (ledger, keys, usage, logs), Redis (rate limits, holds, leases)                  |
| Upstream    | Google Vertex AI REST API (`aiplatform.googleapis.com`)                                     |
| Tests       | Vitest (API, including end-to-end tests against real PostgreSQL and Redis), Jest (packages) |
| Tooling     | pnpm workspaces, ESLint, Prettier, Docker                                                   |

## Quick start (local development)

**Requirements:** Node.js 22+, pnpm (through Corepack), PostgreSQL 16+ and Redis 7+ (or Docker to run
them), and a Google Cloud project with the Vertex AI API enabled.

```bash
git clone https://github.com/Abdodiab2005/vertex-ai-proxy.git
cd vertex-ai-proxy
corepack enable

cp .env.example .env
# In .env, set:
#   DB_PASSWORD=<any local password>
#   CREDENTIALS_ENCRYPTION_KEY=<output of: openssl rand -base64 32>

docker compose up -d            # local PostgreSQL and Redis (or point .env at your own)
pnpm install
pnpm migration:run
pnpm admin:create-owner --email you@example.com   # prompts for a password (12+ characters)

pnpm dev:api                    # API on http://localhost:3000
pnpm dev:admin                  # admin panel on http://localhost:3001
```

Then, in the admin panel at <http://localhost:3001>:

1. **Upstreams → New**: add your Vertex AI project and credentials, then **Test Connection** with a
   model such as `gemini-2.5-flash`.
2. **Models → New**: add the models you want to offer (for example `gemini-2.5-flash`), enable them,
   and set their **pricing** (at least `input_tokens` and `output_tokens`, per 1M tokens).
3. **API Keys → New**: create a key (the raw key is shown once) and give it credit.

### Vertex AI authentication

| Method                          | What to provide                   | Notes                                                                                                          |
| ------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Application Default Credentials | Nothing; the API process uses ADC | Grant the identity `roles/aiplatform.user`                                                                     |
| Service account                 | The service-account key JSON      | Stored encrypted; only the account email is shown back                                                         |
| Express-mode API key            | A Vertex AI API key               | Simplest setup; model **sync** is unavailable (Google's model catalog rejects API keys), so add models by name |

The location (`global`, `us-central1`, `us`, `eu`, …) selects the Vertex endpoint.

## Using the API

Point any Gemini client at your gateway and use a gateway key instead of a Google key.

```bash
export GATEWAY_URL=http://localhost:3000   # your public API URL in production
export GATEWAY_KEY=lvg_...                 # a key created in the admin panel

curl "$GATEWAY_URL/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Explain prepaid billing in one sentence."}]}]}'
```

Streaming (`alt=sse` is required):

```bash
curl --no-buffer "$GATEWAY_URL/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" \
  -H "x-goog-api-key: $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Count from 1 to 10."}]}]}'
```

**JavaScript / TypeScript** (`@google/genai`):

```js
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GATEWAY_KEY,
  httpOptions: { baseUrl: process.env.GATEWAY_URL },
});

const response = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: "Hello from the gateway",
});
console.log(response.text);
```

**Python** (`google-genai`):

```python
import os
from google import genai
from google.genai import types

client = genai.Client(
    api_key=os.environ["GATEWAY_KEY"],
    http_options=types.HttpOptions(base_url=os.environ["GATEWAY_URL"]),
)
response = client.models.generate_content(model="gemini-2.5-flash", contents="Hello from the gateway")
print(response.text)
```

### Endpoints

| Method | Path                                                   | Notes                                                      |
| ------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| `GET`  | `/v1beta/models`                                       | The models enabled in the admin panel that the key may use |
| `GET`  | `/v1beta/models/{model}`                               | Public name or alias                                       |
| `POST` | `/v1beta/models/{model}:generateContent`               | Billed                                                     |
| `POST` | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | Billed; server-sent events                                 |
| `POST` | `/v1beta/models/{model}:countTokens`                   | Free                                                       |
| `POST` | `/v1beta/models/{model}:embedContent`                  | Billed (input tokens)                                      |
| `POST` | `/v1beta/models/{model}:batchEmbedContents`            | Billed; used by the SDKs' `embedContent`                   |
| `GET`  | `/health`, `/health/live`, `/health/ready`             | Liveness and readiness                                     |
| `GET`  | `/metrics`                                             | Prometheus format; requires `METRICS_TOKEN`                |

Not supported: the Files API, the Live API, `cachedContents` and tuned models. The tested
compatibility matrix is in [`docs/API_COMPATIBILITY.md`](./docs/API_COMPATIBILITY.md).

## Deployment

The repository ships production Docker images for the API and the admin panel, a Compose stack with
PostgreSQL and Redis, and nginx configurations. Two layouts are supported.

**A. Self-contained.** The bundled nginx owns ports 80/443 and serves two domains (or one domain split
by path):

```bash
cp .env.example deploy/.env      # then edit it; see "Configuration" below
# put TLS certificates in deploy/certs/ (fullchain.pem, privkey.pem)
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

**B. Behind an existing nginx.** For a server that already hosts other sites: the API and the admin
panel listen on loopback ports and your nginx routes the domains to them.

```bash
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.host-proxy.yml up -d --build
sudo sh deploy/nginx/host/install.sh api.example.com admin.example.com
sudo certbot --nginx -d api.example.com -d admin.example.com
```

In both layouts a one-shot `migrate` container applies the database migrations before the API starts.
Create the first administrator inside the stack:

```bash
docker compose -f deploy/docker-compose.prod.yml run --rm api \
  node dist/cli/create-owner.js --email you@example.com
```

**Updating** is `git pull` followed by the same `docker compose ... up -d --build`; migrations run
automatically. The public domain exposes only `/v1beta` and `/health`; the admin API is never
reachable through it.

The full guide (TLS, reverse-proxy trust, health checks, backups and restores, key rotation) is in
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

### Configuration

All configuration comes from environment variables (see [`.env.example`](./.env.example)); runtime
behaviour such as limits, timeouts, the kill switch and budgets is edited in the admin panel's
**Settings**. The essentials:

| Variable                                                      | Required   | Purpose                                                                                           |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | yes        | PostgreSQL connection                                                                             |
| `REDIS_URL`                                                   | yes        | Redis connection                                                                                  |
| `CREDENTIALS_ENCRYPTION_KEY`                                  | yes        | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts upstream credentials, so back it up |
| `NODE_ENV`                                                    | no         | `production` in deployments                                                                       |
| `TRUST_PROXY`                                                 | no         | Which proxy hops to trust for the client IP (the Compose files set it)                            |
| `ADMIN_COOKIE_SECURE`                                         | no         | `true` behind HTTPS                                                                               |
| `METRICS_TOKEN`                                               | no         | Enables `/metrics` (a bearer token of 16+ characters)                                             |
| `SHUTDOWN_GRACE_MS`                                           | no         | How long in-flight requests may finish during shutdown                                            |
| `GATEWAY_API_URL`                                             | admin only | The API URL the admin panel's server calls                                                        |

## Billing model

Prices are set per model and per **billing dimension**, per unit of tokens (usually 1M):

| Dimension                                    | Charged for                                                  |
| -------------------------------------------- | ------------------------------------------------------------ |
| `input_tokens`                               | Prompt tokens (text, images, video, documents)               |
| `output_tokens`                              | Response text                                                |
| `reasoning_tokens`                           | Thinking tokens (falls back to the output price)             |
| `cached_input_tokens`                        | Cached prompt tokens (falls back to the input price)         |
| `audio_input_tokens` / `audio_output_tokens` | Audio (falls back to the input / output price)               |
| `image_output_tokens`                        | Generated images (no fallback: it must be priced explicitly) |

Each usage line is `quantity × price ÷ unit`, rounded half-up to 6 decimal places, and the key's
ledger is debited with the sum. A worked example, the hold (reservation) formula, and the rules for
partial streams and unknown usage are in [`docs/BILLING_AND_CREDITS.md`](./docs/BILLING_AND_CREDITS.md).

> The gateway bills your clients; Google bills you. Keep the configured prices in line with the current
> [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing).

## Security

- Admin passwords are hashed with Argon2id; sessions use HttpOnly, SameSite=Strict cookies; every
  mutation needs a CSRF token; login attempts are rate limited atomically.
- Gateway keys are stored only as SHA-256 hashes; upstream credentials are encrypted with AES-256-GCM.
- Request logs hold metadata only, never prompts or responses; access logs never contain query strings
  (where a `?key=` would appear).
- Browsers only ever talk to the admin panel's origin, and the API's admin routes are not exposed on
  the public domain.

Details: [`docs/SECURITY.md`](./docs/SECURITY.md). To report a vulnerability, see
[`SECURITY.md`](./SECURITY.md).

## Project structure

```text
apps/
  api/          NestJS gateway: public Gemini API and admin REST API
  admin/        Next.js admin panel
packages/
  database/     TypeORM entities and migrations
  contracts/    Shared enums and types
  shared/       Framework-agnostic utilities (env validation, encryption)
deploy/         Production Compose files and nginx configurations
docker/         Dockerfiles for the API and the admin panel
docs/           Architecture, API compatibility, billing, deployment, security
scripts/        End-to-end test runner and a live compatibility smoke check
```

## Development

```bash
pnpm lint          # ESLint across the workspace
pnpm typecheck     # TypeScript across the workspace
pnpm test          # unit tests
pnpm build         # build everything
pnpm test:e2e      # end-to-end tests against real PostgreSQL and Redis
```

End-to-end tests refuse to run unless the database name ends in `_test` and the Redis database is
numbered 8–15, and they create the test database on first run. Schema changes go through TypeORM
migrations (`pnpm migration:run` / `pnpm migration:revert`); see [`AGENTS.md`](./AGENTS.md) for
generating one and for the repository's conventions.

To check a running gateway against real Vertex AI (about a dozen small requests):

```bash
GATEWAY_URL=http://localhost:3000 GATEWAY_KEY=lvg_... MODEL=gemini-2.5-flash \
  EMBED_MODEL=gemini-embedding-001 pnpm compat:smoke
```

## Limitations

- Vertex AI is the only upstream provider.
- Prices do not model long-context tiers (Vertex charges more for prompts over 200K tokens on some
  models).
- Model sync needs OAuth credentials (ADC or a service account); with an express-mode API key, add
  models by name.
- Storing prompt or response content is intentionally not implemented.

## Contributing

Contributions are welcome; see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)

---

_This project is not affiliated with, endorsed by, or sponsored by Google. Gemini and Vertex AI are
trademarks of Google LLC._
