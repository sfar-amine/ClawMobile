#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$HOME/ClawMobile/installer/termux-lite"; D="$HOME/.openclaw/context-sync"
"$R/context-compact.sh" >/dev/null
n="$(find "$D/pending" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
[ "$n" = 0 ] || { echo "context flush incomplete: pending=$n" >&2; exit 75; }
date -Iseconds >"$D/state/last_flush"
echo CONTEXT_FLUSH_OK
