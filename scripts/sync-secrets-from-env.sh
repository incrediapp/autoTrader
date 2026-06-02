#!/usr/bin/env bash
# Upload secrets from repo-root .env to Secret Manager (no function rollout by default).
#
# Usage:
#   ./scripts/sync-secrets-from-env.sh              # Secret Manager only (fast)
#   ./scripts/sync-secrets-from-env.sh --dry-run
#   ./scripts/sync-secrets-from-env.sh --only ibkr   # IBKR secrets only
#   ./scripts/sync-secrets-from-env.sh --update-functions  # also roll out to all bound functions (slow)
#
# After syncing without --update-functions, deploy the functions you need, e.g.:
#   cd functions && firebase deploy --only functions:connectBroker,functions:tradeLoopScheduled

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
DRY_RUN=false
UPDATE_FUNCTIONS=false
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --update-functions|--force-functions) UPDATE_FUNCTIONS=true ;;
    --only)
      ONLY="${2:-}"
      if [[ -z "$ONLY" ]]; then
        echo "Usage: $0 --only ibkr|app|all" >&2
        exit 1
      fi
      shift
      ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

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

# Firebase CLI prompts "re-deploy functions and destroy stale version?" per secret.
# Do NOT pipe "n" into stdin when using --data-file - (that would upload "n" as the secret).
# --non-interactive skips redeploy prompts; use --update-functions for rollout.
run_secrets_set() {
  local sm_id="$1"
  shift
  if $UPDATE_FUNCTIONS; then
    firebase functions:secrets:set "$sm_id" "$@" --force
  else
    firebase --non-interactive functions:secrets:set "$sm_id" "$@"
  fi
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
    local rollout="Secret Manager only"
    $UPDATE_FUNCTIONS && rollout="Secret Manager + function rollout"
    echo "would set $sm_id (${#value} chars) — $rollout"
    return 0
  fi
  printf '%s' "$value" | run_secrets_set "$sm_id" --data-file -
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
    local rollout="Secret Manager only"
    $UPDATE_FUNCTIONS && rollout="Secret Manager + function rollout"
    echo "would set $sm_id from $resolved — $rollout"
    return 0
  fi
  if [[ "$sm_id" == IBKR_OAUTH_PRIVATE_SIGNATURE || "$sm_id" == IBKR_OAUTH_PRIVATE_ENCRYPTION ]]; then
    # Firebase CLI strips trailing newline from PEM files; store base64 instead.
    local b64
    b64="$(base64 < "$resolved" | tr -d '\n')"
    printf 'b64:%s' "$b64" | run_secrets_set "$sm_id" --data-file -
    echo "set $sm_id from $resolved (base64)"
  else
    run_secrets_set "$sm_id" --data-file "$resolved"
    echo "set $sm_id from $resolved"
  fi
}

extract_dh_prime_from_pem() {
  local pem_path="$1"
  openssl dhparam -in "$pem_path" -text 2>/dev/null \
    | sed -n '/prime:/,/generator:/p' \
    | grep -v generator \
    | tr -d ' \n:' \
    | sed 's/prime//'
}

verify_ibkr_pem_fingerprints() {
  local sig_path="${IBKR_OAUTH_SIGNATURE_PEM_PATH:-}"
  local enc_path="${IBKR_OAUTH_ENCRYPTION_PEM_PATH:-}"
  [[ "$sig_path" != /* ]] && sig_path="$ROOT/$sig_path"
  [[ "$enc_path" != /* ]] && enc_path="$ROOT/$enc_path"
  if [[ ! -f "$sig_path" || ! -f "$enc_path" ]]; then
    return 0
  fi
  node -e "
const { execSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const proj = process.env.GCLOUD_PROJECT || '${GCLOUD_PROJECT:-}';
function fp(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8')).digest('hex').slice(0, 12);
}
function sm(name) {
  return execSync('firebase functions:secrets:access ' + name + ' --project ' + proj, { encoding: 'utf8' });
}
function decodePem(raw) {
  const t = raw.trim();
  if (t.startsWith('b64:')) return Buffer.from(t.slice(4), 'base64').toString('utf8');
  return raw;
}
const checks = [
  ['IBKR_OAUTH_PRIVATE_SIGNATURE', '$sig_path'],
  ['IBKR_OAUTH_PRIVATE_ENCRYPTION', '$enc_path'],
];
for (const [id, file] of checks) {
  const local = fp(file);
  const remote = crypto.createHash('sha256').update(decodePem(sm(id))).digest('hex').slice(0, 12);
  if (local !== remote) {
    console.error(id + ' fingerprint mismatch: local=' + local + ' secret_manager=' + remote);
    process.exit(1);
  }
}
console.log('IBKR PEM fingerprints match Secret Manager');
" || {
      echo "PEM upload verification failed — re-run sync or upload PEMs manually." >&2
      exit 1
    }
}

validate_dh_prime() {
  local hex="$1"
  if [[ ${#hex} -lt 256 ]]; then
    echo "Invalid IBKR_OAUTH_DH_PRIME (${#hex} chars). Expected ~512 hex chars from dhparam.pem." >&2
    return 1
  fi
  if [[ ! "$hex" =~ ^[0-9a-fA-F]+$ ]]; then
    echo "Invalid IBKR_OAUTH_DH_PRIME (non-hex characters)." >&2
    return 1
  fi
}

should_sync() {
  local group="$1"
  case "$ONLY" in
    ""|all) return 0 ;;
    ibkr) [[ "$group" == ibkr ]] ;;
    app) [[ "$group" == app ]] ;;
    *)
      echo "Unknown --only value: $ONLY (use ibkr, app, or all)" >&2
      exit 1
      ;;
  esac
}

cd "$ROOT"
echo "Syncing secrets to Firebase project ${GCLOUD_PROJECT:-unknown}..."
if $UPDATE_FUNCTIONS; then
  echo "Mode: update Secret Manager and roll out to all functions using each secret (slow)."
else
  echo "Mode: Secret Manager only (--non-interactive, no function rollout). Deploy functions when ready."
fi
[[ -n "$ONLY" && "$ONLY" != all ]] && echo "Filter: --only $ONLY"

if should_sync app; then
  set_secret anthropic_api_key "${ANTHROPIC_API_KEY:-}"
  set_secret newsdata_api_key "${NEWSDATA_API_KEY:-}"
  set_secret fmp_api_key "${FMP_API_KEY:-}"
fi

if should_sync ibkr; then
  set_secret ibkr_oauth_consumer_key "${IBKR_OAUTH_CONSUMER_KEY:-}"
  set_secret ibkr_oauth_access_token "${IBKR_OAUTH_ACCESS_TOKEN:-}"
  set_secret ibkr_oauth_access_token_secret "${IBKR_OAUTH_ACCESS_TOKEN_SECRET:-}"

  DH_PRIME_VALUE="${IBKR_OAUTH_DH_PRIME:-}"
  if [[ -z "${DH_PRIME_VALUE// }" && -n "${IBKR_OAUTH_SIGNATURE_PEM_PATH:-}" ]]; then
    PEM_DH="$ROOT/$(dirname "${IBKR_OAUTH_SIGNATURE_PEM_PATH}")/dhparam.pem"
    if [[ -f "$PEM_DH" ]]; then
      DH_PRIME_VALUE="$(extract_dh_prime_from_pem "$PEM_DH")"
      echo "Derived IBKR_OAUTH_DH_PRIME from $PEM_DH"
    fi
  fi
  if ! validate_dh_prime "$DH_PRIME_VALUE"; then
    echo "Fix .env IBKR_OAUTH_DH_PRIME or run: ./scripts/generate-ibkr-oauth-keys.sh" >&2
    exit 1
  fi
  set_secret ibkr_oauth_dh_prime "$DH_PRIME_VALUE"
  set_file_secret ibkr_oauth_private_signature "${IBKR_OAUTH_SIGNATURE_PEM_PATH:-}"
  set_file_secret ibkr_oauth_private_encryption "${IBKR_OAUTH_ENCRYPTION_PEM_PATH:-}"

  if ! $DRY_RUN; then
    verify_ibkr_pem_fingerprints
  fi
fi

echo "Done."
if ! $UPDATE_FUNCTIONS && ! $DRY_RUN; then
  echo "Next: cd functions && firebase deploy --only functions:<names-you-need>"
fi
