#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

URL="${CLAW_LIVE_URL:-http://127.0.0.1:8765/v1/extensions/claw-live}"

if ! curl -fsS --max-time 2 "$URL" >/dev/null 2>&1; then
  echo "claw_live_companion_unavailable" >&2
  exit 69
fi

if command -v termux-open-url >/dev/null 2>&1; then
  exec termux-open-url "$URL"
fi

if command -v adb >/dev/null 2>&1; then
  exec adb -s "${ADB_SERIAL:-127.0.0.1:5556}" shell am start     -a android.intent.action.VIEW -d "$URL"
fi

echo "no_browser_launcher_available" >&2
exit 69
