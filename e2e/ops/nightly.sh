#!/usr/bin/env bash
# Nightly wrapper for the Rentular browser tests on a runner host.
#
# 1. Skips the run when a course (or anything else) asked for a quiet host.
# 2. Updates the checkout to the latest main.
# 3. Runs e2e/run-compose.sh at low priority.
# 4. Mails the summary when something failed (needs a working `mail` or
#    `sendmail` through the host's relay). The exit code is passed on, so a
#    monitoring system can watch the systemd unit as well.
#
# Settings come from /etc/rentular-e2e.env (see docs/TESTING-OPERATIONS.md):
#   E2E_REPO_DIR       checkout of https://github.com/jnuyens/rentular
#   E2E_REPORT_ROOT    where dated report folders go
#   E2E_ALERT_EMAIL    who gets the failure mail (empty: no mail)
#   E2E_SKIP_FILE      if this file exists, skip tonight (default /run/rentular-e2e.skip)
#   E2E_SKIP_COMMAND   optional command; exit code 0 means "busy, skip"
set -uo pipefail

REPO="${E2E_REPO_DIR:?set E2E_REPO_DIR}"
SKIP_FILE="${E2E_SKIP_FILE:-/run/rentular-e2e.skip}"
log() { printf '[rentular-e2e] %s\n' "$*"; }

if [ -e "$SKIP_FILE" ]; then
  log "skip file $SKIP_FILE present, not running tonight"
  exit 0
fi
if [ -n "${E2E_SKIP_COMMAND:-}" ] && bash -c "$E2E_SKIP_COMMAND"; then
  log "skip command says the host is busy, not running tonight"
  exit 0
fi

cd "$REPO" || exit 2
git fetch --quiet origin main && git reset --quiet --hard origin/main || {
  log "could not update the checkout"
  exit 2
}

nice -n 10 ionice -c3 "$REPO/e2e/run-compose.sh"
RESULT=$?

if [ "$RESULT" -ne 0 ] && [ -n "${E2E_ALERT_EMAIL:-}" ]; then
  LATEST="$(ls -1d "${E2E_REPORT_ROOT:-$REPO/e2e/artifacts}"/*/ 2>/dev/null | tail -n 1)"
  BODY="$( { echo "The Rentular browser tests failed on $(hostname) (exit code $RESULT)."; echo "Report folder: ${LATEST:-unknown}"; echo; cat "${LATEST}summary.txt" 2>/dev/null || echo "No summary.txt, see run.log and build.log in the report folder."; } )"
  SUBJECT="Rentular browser tests failed on $(hostname)"
  if command -v mail >/dev/null 2>&1; then
    printf '%s\n' "$BODY" | mail -s "$SUBJECT" "$E2E_ALERT_EMAIL"
  elif command -v sendmail >/dev/null 2>&1; then
    printf 'To: %s\nSubject: %s\n\n%s\n' "$E2E_ALERT_EMAIL" "$SUBJECT" "$BODY" | sendmail -t
  else
    log "no mail or sendmail command, cannot send the alert"
  fi
fi
exit "$RESULT"
