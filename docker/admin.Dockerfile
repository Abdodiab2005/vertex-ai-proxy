# syntax=docker/dockerfile:1

# Major is pinned. The floating minor tag tracks Node 22 security updates.
FROM node:22-bookworm-slim AS base

# package.json "packageManager" is pnpm@12.6.0. Prepare that exact version so
# the image does not float to a newer pnpm that corepack might otherwise select.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

FROM base AS build

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --filter @gateway/admin...

COPY apps/admin apps/admin
COPY tsconfig.base.json tsconfig.base.json

# next build with output: "standalone". GATEWAY_API_URL is intentionally not
# set here: the panel reads it from the process environment when the server starts.
RUN pnpm --filter @gateway/admin run build \
 && test -f /src/apps/admin/.next/standalone/apps/admin/server.js \
 && test -d /src/apps/admin/.next/static

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV NEXT_TELEMETRY_DISABLED=1

# Standalone output omits .next/static. With outputFileTracingRoot at the
# monorepo root, server.js lives under apps/admin inside the standalone tree.
COPY --from=build --chown=node:node /src/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /src/apps/admin/.next/static ./apps/admin/.next/static

USER node

WORKDIR /app/apps/admin

EXPOSE 3001

# /login renders without calling the API, so this stays green while the API boots.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

# Docker sets HOSTNAME to the container id, and the standalone server binds to
# that name. Override it for this process only, or other containers cannot connect.
# exec replaces the shell so node is PID 1 and receives SIGTERM.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
