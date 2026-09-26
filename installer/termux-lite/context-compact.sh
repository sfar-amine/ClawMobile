#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
D="$HOME/.openclaw/context-sync"; L="$D/context-compact.log"
mkdir -p "$D" "$D/pending" "$D/processed" "$D/state" "$D/history"
exec 9>"$D/context-compact.lock"; flock -n 9 || exit 0
result="$(python3 "$HOME/ClawMobile/installer/termux-lite/context-compact.py")"
printf '%s component=context-compactor event=compact result=ok detail=%s\n' "$(date -Iseconds)" "$result" >>"$L"
printf '%s\n' "$result"
