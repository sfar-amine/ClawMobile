#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$HOME/ClawMobile/installer/termux-lite"
PROMPT="$HOME/.cache/openclaw-headless-smoke.txt"
mkdir -p "$HOME/.cache"
printf '%s\n' 'Return exactly HEADLESS_OK and nothing else.' >"$PROMPT"
out="$(timeout 45 "$ROOT/openclaw-agent-secure" --message-file "$PROMPT" --model custom-po-zapro-su/gpt-5.6-luna --thinking off --code-mode direct --timeout 25 --json 2>/dev/null)"
python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d.get("ok") is True and d.get("final","").strip()=="HEADLESS_OK"' <<<"$out"
printf '%s\n' HEADLESS_SMOKE_OK
