# AGENTS.md

Conventions for anyone (human or coding agent) changing this repository: a Gemini-API-compatible
gateway in front of Google Vertex AI. The product overview is in [`README.md`](./README.md); design
notes are under [`docs/`](./docs).

## Layout

- `apps/api` — NestJS gateway (public Gemini-compatible API + admin REST API)
- `apps/admin` — Next.js admin control panel
- `packages/database` — TypeORM entities, migrations, data source
- `packages/contracts` — shared enums/types, no framework dependency
- `packages/shared` — small framework-agnostic utilities (env validation, ...)

## Gate commands (run from repo root)

- Install: `pnpm install`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`
- Build: `pnpm build`

Each fans out to every workspace package via `pnpm -r --if-present run <script>` — a package without
that script is skipped, not failed.

## Local infrastructure

Copy `.env.example` to `.env` and set `DB_PASSWORD`, then:

```bash
docker compose up -d
pnpm install
pnpm migration:run
pnpm admin:create-owner --email you@example.com  # prompts for password; also accepts it on stdin (only works while no admin exists)
pnpm dev:api     # apps/api on $PORT (default 3000)
pnpm dev:admin   # apps/admin on :3001 (fixed, so it never collides with the api's 3000)
```

## End-to-end tests

`pnpm test:e2e` boots the real NestJS API against PostgreSQL and Redis. Postgres and Redis need
to be running (`docker compose up -d` is enough) and the test database has to exist once:

```bash
sudo -u postgres createdb -O gateway gemini_gateway_test
```

The suite truncates its tables and flushes its Redis database. It refuses to start unless `DB_NAME`
ends with `_test` and `REDIS_URL` selects Redis database 8-15, so it never touches dev data.
Parallel checkouts (git worktrees) must not share a test database, because their branches can carry
different migrations. Give each one its own: `E2E_DB_NAME=gemini_gateway_<name>_test E2E_REDIS_DB=<8-14>
pnpm test:e2e`. A missing database is created on first run, which needs the role's CREATEDB
privilege once (`sudo -u postgres psql -c "ALTER ROLE gateway CREATEDB"`).

## Migrations

Run from repo root, after changing entities in `packages/database/src/entities`. TypeORM's CLI wants
the migration path as a positional argument, which doesn't survive the `pnpm migration:generate`
wrapper's arg-forwarding cleanly — call it directly instead:

```bash
pnpm exec dotenv -e .env -- pnpm --filter @gateway/database exec typeorm-ts-node-commonjs migration:generate src/migrations/<Name> -d src/data-source.ts
pnpm migration:run
pnpm migration:revert
```

`src/data-source.ts` must export exactly one `DataSource` instance (a named export alongside `export
default` of the same object counts as two, and the CLI refuses to load it) — keep it to `export
default` only.

## Conventions

- `packages/database`, `packages/contracts`, and `packages/shared` build to `dist/` (`main`/`types`
  point there, not at `src/`). This is required, not stylistic: `apps/api` runs as real Node ESM, and
  Node's runtime loader cannot execute a `.ts` file directly (`tsc`/`vitest`/`ts-node` are all
  TS-aware and don't hit this, which is why the gap was easy to miss in typecheck/test but broke at
  actual boot). `pnpm dev:api` / `pnpm dev:admin` run `build:packages` first automatically; if you add
  a workspace package apps/api depends on, give it a `build` script and `dist/`-pointing `main`/`types`
  too, or its consumers will boot-crash with `ERR_UNKNOWN_FILE_EXTENSION`.
- The single `.env` at repo root is the only env file. Nothing loads it automatically — `dev:api`,
  `dev:admin`, and the `migration:*` scripts wrap the underlying command with `dotenv-cli`
  (`dotenv -e .env -- ...`) specifically because those commands run with their own package as cwd,
  not the repo root, so a plain `dotenv.config()` inside the source wouldn't find it. If you add a new script that
  needs env vars, wrap it the same way rather than hardcoding a relative path to `.env` in source.
- `apps/api` is an ESM package (`"type": "module"`) — required by NestJS 12, which ships ESM-only.
  Every relative import needs an explicit `.js` extension even though the source is `.ts`
  (`import { AppModule } from "./app.module.js"`), or `tsc` fails under `moduleResolution: nodenext`.
  Package imports (`@nestjs/...`, `@gateway/...`, `typeorm`, ...) are unaffected. `packages/*` stay
  CommonJS — only `apps/api` needed to move. `apps/api` uses Vitest, not Jest, because
  `@nestjs/testing` is itself ESM-only and Jest's CJS-by-default transform can't load it; the other
  workspace packages still use Jest since nothing in them is ESM-only.
- `@gateway/database`'s main barrel (`src/index.ts`) deliberately does NOT export `AppDataSource` —
  that file constructs a real `DataSource` (and validates the full DB env) at import time, which is
  correct for the TypeORM CLI (loads it directly by path) but would break any other consumer that
  only wants entities/types. Import `@gateway/database/data-source` directly if you need the instance.
- The root `package.json` lists `ioredis` as a devDependency on purpose. TypeORM has an optional
  `ioredis` peer. Without the root entry, pnpm links one TypeORM copy for `apps/api` (which has
  ioredis) and another for `packages/database` (which doesn't), so entity metadata and `DataSource`
  would live in two module instances. The root entry makes every workspace package resolve the same
  copy. Check with `readlink -f apps/api/node_modules/typeorm packages/database/node_modules/typeorm`
  after dependency changes: both must print the same path.
- Money is always Postgres `numeric` and a TypeScript `string` — never a JS float. See
  `packages/database/src/entities/credit-transaction.entity.ts`.
- New upstream providers, auth methods, and billing dimensions must not require a migration — they're
  plain strings with documented known-values in `packages/contracts/src/open-types.ts`, not Postgres
  enums. Only `ApiKeyStatus` and `CreditTransactionType` are real (Postgres + TS) enums — both are
  closed sets that gate security/accounting control flow.
- `request_logs` never gains a column for prompt/response content. Content logging is a separate,
  explicit opt-in feature with its own retention policy, never this table.
- When a change adds a new required env var, add it to `.env.example` and to that app's zod schema
  (`src/config/env.ts`) in the same change.
- Never commit `.env`, service account JSON, or any real credential — see `.gitignore`.
