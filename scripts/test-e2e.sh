#!/bin/sh
# Runs the apps/api end-to-end suite against a test database and Redis DB.
# E2E_DB_NAME / E2E_REDIS_DB pick them (defaults: gemini_gateway_test, 15). Runs that
# share a database take turns on a lock, because each test truncates the tables;
# runs on different databases proceed in parallel.
set -eu

db="${E2E_DB_NAME:-gemini_gateway_test}"
redis_db="${E2E_REDIS_DB:-15}"

exec flock "/tmp/gateway-e2e-$db.lock" sh -c '
  pnpm run build:packages &&
  dotenv -e .env -v "DB_NAME=$1" -v "REDIS_URL=redis://localhost:6379/$2" -- \
    pnpm --filter @gateway/api run test:e2e
' e2e "$db" "$redis_db"
