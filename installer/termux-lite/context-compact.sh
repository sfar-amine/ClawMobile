#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
D="${SAMANTHA_CONTEXT_ROOT:-$HOME/.openclaw/context-sync}"; L="$D/context-compact.log"
mkdir -p "$D" "$D/pending" "$D/processed" "$D/state" "$D/history"
exec 9>"$D/context-compact.lock"; flock -n 9 || exit 0
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
result="$(python3 "$HERE/context-compact.py")"
printf '%s component=context-compactor event=compact result=ok detail=%s\n' "$(date -Iseconds)" "$result" >>"$L"
printf '%s\n' "$result"
