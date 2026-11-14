#!/usr/bin/env bash
# Entry point of the e2e runner container. Prepares the database (local mode),
# waits for the app, runs the tests and leaves the report in $E2E_ARTIFACTS_DIR.
set -euo pipefail
cd /repo

log() { printf '[e2e-runner] %s\n' "$*"; }

wait_for() {
  local url="$1" name="$2" tries="${3:-300}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then log "$name is up"; return 0; fi
    sleep 2
  done
  log "$name did not come up at $url"
  return 1
}

mkdir -p "$E2E_ARTIFACTS_DIR"

if [ "${E2E_REMOTE:-0}" != "1" ]; then
  log "creating the schema"
  DB_HOST="$E2E_DB_HOST" DB_PORT=3306 DB_NAME=rentular_e2e DB_USER=rentular_e2e DB_PASSWORD="$E2E_DB_PASSWORD" \
    pnpm --filter @rentular/db exec drizzle-kit push --force >"$E2E_ARTIFACTS_DIR/db-push.log" 2>&1 \
    || { log "schema push failed, see db-push.log"; exit 1; }
  log "seeding test accounts"
  pnpm --silent --filter @rentular/e2e exec tsx src/seed.ts
fi

wait_for "${E2E_API_URL}/health" "API"
wait_for "${E2E_BASE_URL}/login" "web app"

log "running browser tests against ${E2E_BASE_URL}"
exec pnpm --silent --filter @rentular/e2e exec tsx src/run.ts
