#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; D="${SAMANTHA_CONTEXT_ROOT:-$HOME/.openclaw/context-sync}"
mkdir -p "$D"; exec 9>"$D/context-dream.lock"; flock -n 9 || exit 0
exec python3 "$R/context-dream.py"
