#!/usr/bin/env bash
# Optional: decrypt IBKR portal access token secret (hex ciphertext) for debugging.
#
# For autoTrader / ibkr-client you normally do NOT use this output in .env.
# Set IBKR_OAUTH_ACCESS_TOKEN_SECRET to the encrypted value from the IBKR portal
# (base64), which the client decrypts with private_encryption.pem.
#
# Usage: ./scripts/decrypt-ibkr-access-token-secret.sh ENCRYPTED_HEX_OR_FILE

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$ROOT/secrets/ibkr/private_encryption.pem"

if [[ ! -f "$KEY" ]]; then
  echo "Missing $KEY — run ./scripts/generate-ibkr-oauth-keys.sh first" >&2
  exit 1
fi

INPUT="${1:-}"
if [[ -z "$INPUT" ]]; then
  echo "Paste encrypted access token secret (hex), then Ctrl-D:" >&2
  INPUT="$(cat)"
fi

if [[ -f "$INPUT" ]]; then
  INPUT="$(tr -d ' \n' < "$INPUT")"
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
echo "$INPUT" | xxd -r -p > "$TMP"

openssl rsautl -decrypt -inkey "$KEY" -in "$TMP" | xxd -p -c 256
