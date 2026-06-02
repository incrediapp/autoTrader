#!/usr/bin/env bash
# Serves on a fixed port; open http://localhost:7357 in your everyday Chrome profile.
set -euo pipefail
cd "$(dirname "$0")/../flutter_app"
exec flutter run -d web-server \
  --web-hostname=localhost \
  --web-port=7357 \
  "$@"
