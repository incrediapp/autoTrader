#!/usr/bin/env bash
# Test IBKR OAuth using Secret Manager only (same source as deployed Cloud Functions).
# Usage: ./scripts/test-ibkr-secrets-from-gcp.sh [gcp-project-id]

set -euo pipefail
PROJECT="${1:-${GCLOUD_PROJECT:-ai-auto-trader-a15c0}}"

read_sm() {
  firebase functions:secrets:access "$1" --project "$PROJECT" 2>/dev/null
}

export IBKR_OAUTH_CONSUMER_KEY="$(read_sm IBKR_OAUTH_CONSUMER_KEY)"
export IBKR_OAUTH_ACCESS_TOKEN="$(read_sm IBKR_OAUTH_ACCESS_TOKEN)"
export IBKR_OAUTH_ACCESS_TOKEN_SECRET="$(read_sm IBKR_OAUTH_ACCESS_TOKEN_SECRET)"
export IBKR_OAUTH_DH_PRIME="$(read_sm IBKR_OAUTH_DH_PRIME)"
export IBKR_OAUTH_PRIVATE_SIGNATURE="$(read_sm IBKR_OAUTH_PRIVATE_SIGNATURE)"
export IBKR_OAUTH_PRIVATE_ENCRYPTION="$(read_sm IBKR_OAUTH_PRIVATE_ENCRYPTION)"

cd "$(dirname "$0")/../functions"
node -e "
const { pingIbkrCredentials, resetIbkrSession, getIbkrOAuthDiagnostics } = require('./src/brokers/ibkrSession');
(async () => {
  resetIbkrSession();
  console.log('config', await getIbkrOAuthDiagnostics());
  await pingIbkrCredentials();
  console.log('IBKR ping OK (Secret Manager only)');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
"
