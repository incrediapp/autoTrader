#!/usr/bin/env bash
# Fixed port keeps Firebase Auth guest sessions in localStorage between restarts.
set -euo pipefail
cd "$(dirname "$0")/../flutter_app"
flutter run -d chrome --web-hostname=localhost --web-port=7357 "$@"
