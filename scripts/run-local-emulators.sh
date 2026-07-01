#!/usr/bin/env bash
# Start Firebase local emulators (Firestore + Auth + Cloud Functions).
#
# Ports (from firebase.json):
#   Firestore  http://127.0.0.1:8080
#   Auth       http://127.0.0.1:9099
#   Functions  http://127.0.0.1:5001
#   Emulator UI http://127.0.0.1:4000  (Firebase default when ui.enabled)
#
# Note: Firebase *Storage* emulator is not configured in this repo (default would be 9199).
# Flutter web dev server uses port 7357 — see scripts/run-web.sh
#
# Usage:
#   ./scripts/run-local-emulators.sh
#   ./scripts/run-local-emulators.sh --import=./emulator-data --export-on-exit

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
  echo "Loaded $ENV_FILE"
else
  echo "Warning: $ENV_FILE not found — set ANTHROPIC_API_KEY etc. manually if needed." >&2
fi

export GCLOUD_PROJECT="${GCLOUD_PROJECT:-ai-auto-trader-a15c0}"

cd "$ROOT"
echo ""
echo "Starting Firebase emulators for project: $GCLOUD_PROJECT"
echo "  Firestore :8080  Auth :9099  Functions :5001  UI :4000"
echo ""

exec firebase emulators:start --only functions,firestore,auth "$@"
