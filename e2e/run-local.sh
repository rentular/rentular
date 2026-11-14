#!/usr/bin/env bash
# Runs the Rentular browser tests against a throwaway local stack.
#
#   e2e/run-local.sh            build, start, test, tear down
#   E2E_PROJECTS=chromium-desktop e2e/run-local.sh   one browser only
#   E2E_SKIP_BUILD=1 e2e/run-local.sh                reuse the last web build
#   E2E_KEEP_UP=1 e2e/run-local.sh                   start the stack and wait,
#                                                    no tests (Ctrl-C stops it)
#
# MariaDB, Redis and Mailpit run in Docker (e2e/docker-compose.deps.yml) on
# 127.0.0.1 only, with their data in tmpfs. The API and the web app run on the
# host with a clean environment that holds only the e2e settings, so nothing
# from your shell (real SMTP, Stripe, bank keys) leaks into the test run.
# Everything started here is stopped again on exit, also on failure or Ctrl-C.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$E2E_DIR/.." && pwd)"
cd "$ROOT"

log() { printf '[e2e] %s\n' "$*"; }

for tool in docker node pnpm curl; do
  command -v "$tool" >/dev/null 2>&1 || { log "missing tool: $tool"; exit 2; }
done

bash "$E2E_DIR/scripts/init-env.sh"
set -a
# shellcheck disable=SC1091
. "$E2E_DIR/.env.e2e.local"
set +a

STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
export E2E_ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR:-$E2E_DIR/artifacts/$STAMP}"
mkdir -p "$E2E_ARTIFACTS_DIR"
COMPOSE=(docker compose -f "$E2E_DIR/docker-compose.deps.yml" --env-file "$E2E_DIR/.env.e2e.local")

WEB_URL="http://localhost:${E2E_WEB_PORT}"
API_BASE="http://localhost:${E2E_API_PORT}"
PIDS=()

cleanup() {
  local code=$?
  set +e
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    # Each server runs in its own process group (set -m below), so this stops
    # pnpm, tsx/next and their children together.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL -- "-$pid" 2>/dev/null
  done
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  log "stack stopped; artifacts in ${E2E_ARTIFACTS_DIR}"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Only these variables reach the API and the web app.
app_env() {
  env -i \
    HOME="$HOME" PATH="$PATH" TERM="${TERM:-dumb}" LANG=C.UTF-8 TZ=UTC \
    NODE_ENV="${1}" \
    DB_HOST=127.0.0.1 DB_PORT="$E2E_DB_PORT" DB_NAME=rentular_e2e DB_USER=rentular_e2e \
    DB_PASSWORD="$E2E_DB_PASSWORD" \
    REDIS_URL="redis://127.0.0.1:${E2E_REDIS_PORT}" REDIS_HOST=127.0.0.1 REDIS_PORT="$E2E_REDIS_PORT" \
    SMTP_HOST=127.0.0.1 SMTP_PORT="$E2E_SMTP_PORT" EMAIL_FROM=noreply@e2e.local \
    AUTH_SECRET="$E2E_AUTH_SECRET" AUTH_URL="$WEB_URL" AUTH_TRUST_HOST=true \
    WEB_URL="$WEB_URL" ALLOWED_ORIGINS="$WEB_URL" \
    NEXT_PUBLIC_API_URL="${API_BASE}" NEXT_PUBLIC_SITE_URL="$WEB_URL" \
    API_PORT="$E2E_API_PORT" PORT="$E2E_WEB_PORT" \
    SMS_PROVIDER=console APP_TIMEZONE=Europe/Brussels NEXT_TELEMETRY_DISABLED=1 \
    "${@:2}"
}

wait_for() {
  local url="$1" name="$2" tries="${3:-120}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then log "$name is up"; return 0; fi
    sleep 1
  done
  log "$name did not come up at $url"
  return 1
}

log "starting MariaDB, Redis and Mailpit"
"${COMPOSE[@]}" up -d --wait >/dev/null

log "creating the schema (drizzle-kit push)"
app_env development pnpm --filter @rentular/db exec drizzle-kit push --force \
  >"$E2E_ARTIFACTS_DIR/db-push.log" 2>&1 || { log "schema push failed, see db-push.log"; exit 1; }

log "seeding test accounts"
E2E_DB_HOST=127.0.0.1 pnpm --silent --filter @rentular/e2e exec tsx src/seed.ts

if [ "${E2E_SKIP_BUILD:-0}" != "1" ] || [ ! -f apps/web/.next/BUILD_ID ]; then
  log "building the web app (takes a few minutes)"
  app_env production pnpm --filter @rentular/web build >"$E2E_ARTIFACTS_DIR/web-build.log" 2>&1 \
    || { log "web build failed, see web-build.log"; exit 1; }
fi

set -m
log "starting the API on ${API_BASE}"
app_env development pnpm --filter @rentular/api exec tsx src/index.ts >"$E2E_ARTIFACTS_DIR/api.log" 2>&1 &
PIDS+=("$!")
log "starting the web app on ${WEB_URL}"
# The app is built with output "standalone", so run that server the same way
# production does (it needs the static assets next to it).
STANDALONE=apps/web/.next/standalone
rm -rf "$STANDALONE/apps/web/.next/static" "$STANDALONE/apps/web/public"
cp -R apps/web/.next/static "$STANDALONE/apps/web/.next/static"
cp -R apps/web/public "$STANDALONE/apps/web/public"
app_env production HOSTNAME=127.0.0.1 node "$STANDALONE/apps/web/server.js" \
  >"$E2E_ARTIFACTS_DIR/web.log" 2>&1 &
PIDS+=("$!")
set +m

wait_for "${API_BASE}/api/v1/health" "API"
wait_for "${WEB_URL}/login" "web app"

if [ "${E2E_KEEP_UP:-0}" = "1" ]; then
  log "stack is up (web ${WEB_URL}, mail ${E2E_MAIL_UI_URL:-http://localhost:${E2E_MAIL_UI_PORT}}). Ctrl-C to stop."
  while true; do sleep 3600 & wait $!; done
fi

log "running browser tests"
set +e
E2E_BASE_URL="$WEB_URL" E2E_API_URL="${API_BASE}/api/v1" \
  pnpm --silent --filter @rentular/e2e exec tsx src/run.ts
RESULT=$?
set -e
exit "$RESULT"
