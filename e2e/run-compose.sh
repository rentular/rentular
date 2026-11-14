#!/usr/bin/env bash
# Runs the Rentular browser tests in containers only (any Linux host with
# Docker or Podman, nothing installed on the host besides that).
#
#   e2e/run-compose.sh                         full run, all four browsers
#   E2E_PROJECTS=chromium-desktop e2e/run-compose.sh
#   E2E_REPORT_ROOT=/srv/rentular-e2e/reports e2e/run-compose.sh
#   E2E_KEEP_DAYS=14                           report folders kept (default 14)
#   COMPOSE="podman compose" e2e/run-compose.sh
#
# Each run writes to a dated folder under $E2E_REPORT_ROOT (default
# e2e/artifacts): summary.txt, results.json, junit.xml, and for every failure
# a screenshot (.png) and a Playwright trace (.trace.zip), plus the container
# logs. Exit code: 0 all passed, 1 test failures, 2 or higher setup problem.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$E2E_DIR"
log() { printf '[e2e] %s\n' "$*"; }

read -r -a COMPOSE_CMD <<<"${COMPOSE:-docker compose}"
bash "$E2E_DIR/scripts/init-env.sh"

REPORT_ROOT="${E2E_REPORT_ROOT:-$E2E_DIR/artifacts}"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
export E2E_REPORT_DIR="$REPORT_ROOT/$STAMP"
mkdir -p "$E2E_REPORT_DIR"
export E2E_UID="${E2E_UID:-$(id -u)}" E2E_GID="${E2E_GID:-$(id -g)}"

# Keep the last E2E_KEEP_DAYS days of reports.
find "$REPORT_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${E2E_KEEP_DAYS:-14}" -exec rm -rf {} + 2>/dev/null || true

COMPOSE_ARGS=(-f "$E2E_DIR/docker-compose.e2e.yml" --env-file "$E2E_DIR/.env.e2e.local")

cleanup() {
  local code=$?
  set +e
  "${COMPOSE_CMD[@]}" "${COMPOSE_ARGS[@]}" logs --no-color >"$E2E_REPORT_DIR/stack.log" 2>&1
  "${COMPOSE_CMD[@]}" "${COMPOSE_ARGS[@]}" down -v --remove-orphans >/dev/null 2>&1
  log "stack removed; report in $E2E_REPORT_DIR"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

log "building images (cached after the first run)"
"${COMPOSE_CMD[@]}" "${COMPOSE_ARGS[@]}" build --pull=false >"$E2E_REPORT_DIR/build.log" 2>&1 \
  || { log "image build failed, see build.log"; exit 3; }

log "starting the stack and running the tests"
set +e
"${COMPOSE_CMD[@]}" "${COMPOSE_ARGS[@]}" up --no-build --abort-on-container-exit --exit-code-from runner \
  >"$E2E_REPORT_DIR/run.log" 2>&1
RESULT=$?
set -e
grep -E '^runner-1  \| ' "$E2E_REPORT_DIR/run.log" | sed 's/^runner-1  | //' || true
[ -f "$E2E_REPORT_DIR/summary.txt" ] || { log "no test report was written, see run.log"; [ "$RESULT" -eq 0 ] && RESULT=2; }
exit "$RESULT"
