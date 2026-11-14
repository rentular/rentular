#!/usr/bin/env bash
# Runs the browser tests against an already deployed staging or test instance
# instead of a throwaway stack. Only for an instance you control with test
# data; production (rentular.com) is refused by the test runner itself.
#
# Needs in e2e/.env.e2e.local (or the file in E2E_ENV_FILE):
#   E2E_BASE_URL=https://staging.example.org
#   E2E_API_URL=https://staging.example.org/api/v1
#   E2E_LANDLORD_EMAIL / E2E_LANDLORD_PASSWORD   an existing test landlord
#   E2E_ONBOARDING_EMAIL / E2E_ONBOARDING_PASSWORD (unused in remote mode)
#
# Remote mode skips the tests that create data (onboarding, add tenant,
# create contract, record payment, mute). The focus sweep types into forms
# but never saves them.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${E2E_ENV_FILE:-$E2E_DIR/.env.e2e.local}"
[ -f "$ENV_FILE" ] || { echo "[e2e] $ENV_FILE not found"; exit 2; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${E2E_BASE_URL:?set E2E_BASE_URL in $ENV_FILE}"
: "${E2E_API_URL:?set E2E_API_URL in $ENV_FILE}"

REPORT_ROOT="${E2E_REPORT_ROOT:-$E2E_DIR/artifacts}"
REPORT_DIR="$REPORT_ROOT/$(date +%Y-%m-%dT%H-%M-%S)-remote"
mkdir -p "$REPORT_DIR"
read -r -a CONTAINER_CMD <<<"${CONTAINER:-docker}"

"${CONTAINER_CMD[@]}" build -q -t rentular-e2e-runner -f "$E2E_DIR/Dockerfile" "$E2E_DIR/.." >/dev/null
exec "${CONTAINER_CMD[@]}" run --rm --shm-size=1g \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e E2E_REMOTE=1 -e E2E_BASE_URL -e E2E_API_URL \
  -e E2E_LANDLORD_EMAIL -e E2E_LANDLORD_PASSWORD \
  -e E2E_ONBOARDING_EMAIL -e E2E_ONBOARDING_PASSWORD \
  -e E2E_PROJECTS -e E2E_GREP \
  -e E2E_ARTIFACTS_DIR=/reports -v "$REPORT_DIR:/reports" \
  rentular-e2e-runner
