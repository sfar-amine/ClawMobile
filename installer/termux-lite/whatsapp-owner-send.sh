#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
STATE_DIR="$HOME/.openclaw/health"
STATE_LOG="$STATE_DIR/whatsapp-outbound.log"
mkdir -p "$STATE_DIR"
message="${1:-}"
key="${2:-}"
[ -n "$message" ] && [ -n "$key" ] || exit 64
case "$key" in *[!A-Za-z0-9._:-]*) exit 64;; esac

target="$(python3 - "$HOME/.openclaw/openclaw.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    cfg = json.load(f)
for value in cfg.get("commands", {}).get("ownerAllowFrom", []):
    if isinstance(value, str) and value.startswith("whatsapp:"):
        print(value.split(":", 1)[1])
        break
PY
)"
if [ -z "$target" ]; then
  printf '%s state=failed reason=no_owner_target key=%s\n' "$(date -Iseconds)" "$key" >>"$STATE_LOG"
  exit 66
fi
params="$(python3 - "$target" "$message" "$key" <<'PY'
import json, sys
print(json.dumps({
    "to": sys.argv[1],
    "message": sys.argv[2],
    "channel": "whatsapp",
    "accountId": "default",
    "idempotencyKey": sys.argv[3],
}, ensure_ascii=False))
PY
)"
started="$(date +%s)"
set +e
out="$(timeout 15 openclaw gateway call send --timeout 10000 --json --params "$params")"
rc=$?
set -e
elapsed=$(( $(date +%s) - started ))
if [ "$rc" -ne 0 ]; then
  printf '%s state=failed reason=gateway_call rc=%s elapsed_s=%s key=%s\n' "$(date -Iseconds)" "$rc" "$elapsed" "$key" >>"$STATE_LOG"
  exit "$rc"
fi
message_id="$(printf '%s' "$out" | python3 -c 'import json,sys; o=json.load(sys.stdin); m=o.get("messageId"); assert o.get("channel")=="whatsapp" and isinstance(m,str) and m; print(m)' 2>/dev/null || true)"
if [ -z "$message_id" ]; then
  printf '%s state=failed reason=invalid_response elapsed_s=%s key=%s\n' "$(date -Iseconds)" "$elapsed" "$key" >>"$STATE_LOG"
  exit 67
fi
printf '%s state=accepted elapsed_s=%s key=%s message_id=%s\n' "$(date -Iseconds)" "$elapsed" "$key" "$message_id" >>"$STATE_LOG"
printf '%s\n' "$message_id"