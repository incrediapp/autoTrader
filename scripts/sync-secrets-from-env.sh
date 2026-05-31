#!/usr/bin/env bash
# Upload secrets from repo-root .env to Firebase / Secret Manager.
# Usage: ./scripts/sync-secrets-from-env.sh [--dry-run]

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

to_firebase_id() {
  echo "$1" | tr '[:lower:]' '[:upper:]' | tr '-' '_'
}

set_secret() {
  local logical_name="$1"
  local value="$2"
  local sm_id
  sm_id="$(to_firebase_id "$logical_name")"
  if [[ -z "${value// }" ]]; then
    echo "skip $sm_id (empty)"
    return 0
  fi
  if $DRY_RUN; then
    echo "would set $sm_id (${#value} chars)"
    return 0
  fi
  printf '%s' "$value" | firebase functions:secrets:set "$sm_id" --data-file - --force
  echo "set $sm_id"
}

set_file_secret() {
  local logical_name="$1"
  local file_path="$2"
  local sm_id
  sm_id="$(to_firebase_id "$logical_name")"
  if [[ -z "${file_path// }" ]]; then
    echo "skip $sm_id (no path)"
    return 0
  fi
  local resolved="$file_path"
  if [[ "$file_path" != /* ]]; then
    resolved="$ROOT/$file_path"
  fi
  if [[ ! -f "$resolved" ]]; then
    echo "skip $sm_id (missing file: $resolved)"
    return 0
  fi
  if $DRY_RUN; then
    echo "would set $sm_id from $resolved"
    return 0
  fi
  firebase functions:secrets:set "$sm_id" --data-file "$resolved" --force
  echo "set $sm_id from $resolved"
}

cd "$ROOT"
echo "Syncing secrets to Firebase project ${GCLOUD_PROJECT:-unknown}..."

set_secret anthropic_api_key "${ANTHROPIC_API_KEY:-}"
set_secret newsdata_api_key "${NEWSDATA_API_KEY:-}"
set_secret fmp_api_key "${FMP_API_KEY:-}"

set_secret ibkr_oauth_consumer_key "${IBKR_OAUTH_CONSUMER_KEY:-}"
set_secret ibkr_oauth_access_token "${IBKR_OAUTH_ACCESS_TOKEN:-}"
set_secret ibkr_oauth_access_token_secret "${IBKR_OAUTH_ACCESS_TOKEN_SECRET:-}"
set_secret ibkr_oauth_dh_prime "${IBKR_OAUTH_DH_PRIME:-}"
set_file_secret ibkr_oauth_private_signature "${IBKR_OAUTH_SIGNATURE_PEM_PATH:-}"
set_file_secret ibkr_oauth_private_encryption "${IBKR_OAUTH_ENCRYPTION_PEM_PATH:-}"

echo "Done."
