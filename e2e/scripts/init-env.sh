#!/usr/bin/env bash
# Creates e2e/.env.e2e.local with fresh random secrets when it does not exist
# yet. Existing files are left alone, except that missing keys are appended.
# Secrets are never printed.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${E2E_ENV_FILE:-$E2E_DIR/.env.e2e.local}"

rand() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

add() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

add E2E_DB_ROOT_PASSWORD "$(rand)"
add E2E_DB_PASSWORD "$(rand)"
add E2E_AUTH_SECRET "$(rand)"
add E2E_LANDLORD_EMAIL "landlord@e2e.local"
add E2E_LANDLORD_PASSWORD "$(rand)"
add E2E_ONBOARDING_EMAIL "onboarding@e2e.local"
add E2E_ONBOARDING_PASSWORD "$(rand)"
add E2E_WEB_PORT 3410
add E2E_API_PORT 4410
add E2E_DB_PORT 33306
add E2E_REDIS_PORT 36379
add E2E_SMTP_PORT 31025
add E2E_MAIL_UI_PORT 38025
