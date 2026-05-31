#!/usr/bin/env bash
# Generate IBKR first-party OAuth key material (openssl).
# After running, upload the *public* keys to the IBKR Self-Service OAuth portal:
# https://ndcdyn.interactivebrokers.com/oauth/?action=OAUTH&loginType=1&clt=0#/configuration

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/secrets/ibkr"
mkdir -p "$OUT"

echo "Generating keys in $OUT ..."

openssl genrsa -out "$OUT/private_signature.pem" 2048
openssl rsa -in "$OUT/private_signature.pem" -pubout -out "$OUT/public_signature.pem"

openssl genrsa -out "$OUT/private_encryption.pem" 2048
openssl rsa -in "$OUT/private_encryption.pem" -pubout -out "$OUT/public_encryption.pem"

openssl dhparam -out "$OUT/dhparam.pem" 2048

DH_PRIME="$(openssl dhparam -in "$OUT/dhparam.pem" -text 2>/dev/null | sed -n '/prime:/,/generator:/p' | grep -v generator | tr -d ' \n:' | sed 's/prime//')"

echo ""
echo "=== Next steps (manual, in IBKR portal) ==="
echo "1. Upload: public_signature.pem, public_encryption.pem, dhparam.pem"
echo "2. Choose a 9-character Consumer Key (e.g. $(LC_ALL=C tr -dc 'A-Z0-9' </dev/urandom | head -c 9))"
echo "3. Generate Access Token + Secret in the portal"
echo "4. Decrypt access token secret per IBKR docs (openssl rsautl ...)"
echo "5. Add values to .env:"
echo ""
echo "IBKR_OAUTH_DH_PRIME=$DH_PRIME"
echo ""
echo "Then run: ./scripts/sync-secrets-from-env.sh"
