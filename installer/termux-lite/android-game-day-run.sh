#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
CONTROL="$HOME/.openclaw/tier0/bin/tier0-control.py"
ROOT="${CLAW_RUNTIME_ROOT:-$($CONTROL root)}"
exec python3 "$ROOT/android-game-day.py" --execute --duration-seconds 1800
