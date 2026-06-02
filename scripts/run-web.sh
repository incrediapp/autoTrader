#!/usr/bin/env bash
# Fixed port + Chrome profile keep Firebase Auth sessions between dev restarts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/flutter_app"
PROFILE="$ROOT/flutter_app/.chrome-dev-profile"
mkdir -p "$PROFILE"
exec flutter run -d chrome \
  --web-hostname=localhost \
  --web-port=7357 \
  --web-browser-flag="--user-data-dir=$PROFILE" \
  "$@"
