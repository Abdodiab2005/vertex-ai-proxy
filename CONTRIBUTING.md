# Contributing

Thanks for your interest in improving Vertex AI Proxy. Bug reports, fixes, documentation and features
are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first to agree on the approach.
- Security problems must not be reported in public issues; see [`SECURITY.md`](./SECURITY.md).

## Setting up

Follow the **Quick start** in [`README.md`](./README.md). You need Node.js 22+, pnpm (through Corepack),
PostgreSQL and Redis. [`AGENTS.md`](./AGENTS.md) documents the repository's conventions (ESM rules,
migrations, environment files, money handling) and applies to human and AI-assisted contributions
alike.

## Making a change

1. Create a branch from `main`.
2. Keep the change focused; include tests for new behaviour and for bugs you fix.
3. Run the checks from the repository root before opening a pull request:

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm test:e2e   # needs PostgreSQL and Redis; see README "Development"
   ```

4. Schema changes go through a TypeORM migration (see `AGENTS.md`); never edit an existing migration.
5. New required environment variables go into `.env.example` and the app's `src/config/env.ts` in the
   same change.
6. Open a pull request describing what changed and why, and how you tested it.

## Ground rules

- Money is PostgreSQL `numeric` in the database and a decimal string or BigInt in code, never a
  JavaScript float.
- Request logs never store prompt or response content.
- Never commit `.env` files, service-account JSON, API keys or any other credential.
- Comments explain why, not what.

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
