#!/usr/bin/env bash
# Decrypt IBKR access token secret from the Self-Service OAuth portal.
# Usage: ./scripts/decrypt-ibkr-access-token-secret.sh ENCRYPTED_HEX_OR_FILE
#
# Paste the encrypted access token secret from the IBKR portal as the argument,
# or pass a file containing it (hex string).

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
