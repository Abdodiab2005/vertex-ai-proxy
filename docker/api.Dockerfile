# syntax=docker/dockerfile:1

# Major is pinned. The floating minor tag tracks Node 22 security updates.
# Pin a digest in CI when a rebuild must be byte-for-byte identical.
FROM node:22-bookworm-slim AS base

# package.json "packageManager" is pnpm@12.6.0. Prepare that exact version so
# the image does not float to a newer pnpm that corepack might otherwise select.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

FROM base AS build

WORKDIR /src

# Manifests first so a source-only change does not reinstall dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json

# Full install: the API build needs the Nest CLI and TypeScript. Production
# dependencies are selected later by `pnpm deploy --prod`.
RUN pnpm install --frozen-lockfile --filter @gateway/api...

COPY . .

# Deploy copies whatever is on disk, including gitignored dist/, so the
# packages and the API must be compiled first. The tests fail the image
# instead of booting a tree that cannot run migrations or the owner CLI.
RUN pnpm run build:packages \
 && pnpm --filter @gateway/api run build \
 && pnpm --filter @gateway/api deploy --prod /opt/api \
 && test -f /opt/api/dist/main.js \
 && test -f /opt/api/dist/cli/create-owner.js \
 && test -f /opt/api/node_modules/@gateway/database/dist/data-source.js \
 && test -n "$(find /opt/api/node_modules/@gateway/database/dist/migrations -name '*.js' -print -quit)"

# The process loads dist/ only. Source and the Vitest suite are not needed at runtime.
RUN rm -rf /opt/api/src /opt/api/test \
 && rm -f /opt/api/vitest.config.ts /opt/api/vitest.e2e.config.ts \
    /opt/api/eslint.config.mjs /opt/api/tsconfig.json \
    /opt/api/tsconfig.build.json /opt/api/nest-cli.json

FROM node:22-bookworm-slim AS runtime

# The official slim image already installs ca-certificates, which outbound
# HTTPS to Vertex needs. Do not COPY an .env; secrets come from the runtime.
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build --chown=node:node /opt/api /app

# The image's built-in unprivileged account. uid 1000.
USER node

EXPOSE 3000

# Liveness does not touch Postgres or Redis. A dependency blip must not fail
# this check and get the container restarted; use /health/ready for that.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations (one-shot, needs DB_* only):
#   node /app/node_modules/typeorm/cli.js migration:run -d /app/node_modules/@gateway/database/dist/data-source.js
# Owner bootstrap (stdin is the password when there is no TTY):
#   node /app/dist/cli/create-owner.js --email owner@example.com
CMD ["node", "dist/main.js"]
