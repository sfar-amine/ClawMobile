#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
CONTROL="$HOME/.openclaw/tier0/bin/tier0-control.py"
# R10: run from the current Tier0 release resolved by tier0-control (this runner lives in tier0/bin, not in the release).
ROOT="${CLAW_RUNTIME_ROOT-}"; [ -n "$ROOT" ] || ROOT="$("$CONTROL" root)"
exec python3 "$ROOT/android-game-day.py" --execute --duration-seconds 1800
