#!/data/data/com.termux/files/usr/bin/bash
set -eu
ADB_SERIAL="${CLAWMOBILE_ADB_SERIAL:-127.0.0.1:5556}"
OUT="$HOME/.openclaw/continuity/chatgpt-current.json"
LOG="$HOME/.openclaw/continuity/capture.log"
mkdir -p "$(dirname "$OUT")"
if ! adb -s "$ADB_SERIAL" get-state 2>/dev/null | grep -qx device; then
  printf '%s capture=failed reason=adb_unavailable\n' "$(date -Iseconds)" >>"$LOG"; exit 2
fi
dump="$(adb -s "$ADB_SERIAL" shell dumpsys activity intents 2>/dev/null || true)"
ids="$(printf '%s\n' "$dump" | sed -nE 's#.*https://(www\.)?(chatgpt|chat)\.com/c/([A-Za-z0-9_-]+).*#\3#p' | sort -u)"
count="$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')"
if [ "$count" != 1 ]; then
  printf '%s capture=failed reason=ambiguous_pending_intents count=%s\n' "$(date -Iseconds)" "$count" >>"$LOG"; exit 3
fi
id="$(printf '%s\n' "$ids" | head -1)"
case "$id" in *[!A-Za-z0-9_-]*|'') exit 4;; esac
mode=text
audio="$(adb -s "$ADB_SERIAL" shell appops get com.openai.chatgpt RECORD_AUDIO 2>/dev/null || true)"
if printf '%s\n' "$audio" | grep -Eq 'RECORD_AUDIO:.*running' && ! printf '%s\n' "$audio" | grep -q 'ago'; then mode=voice; fi
tmp="$OUT.tmp.$$"
printf '{\n  "version": 1,\n  "conversationId": "%s",\n  "mode": "%s",\n  "lastSeenAt": "%s",\n  "restore": "ready",\n  "source": "android_pending_intent"\n}\n' "$id" "$mode" "$(date -Iseconds)" >"$tmp"
chmod 600 "$tmp"; mv "$tmp" "$OUT"
printf '%s capture=ok mode=%s id=%s\n' "$(date -Iseconds)" "$mode" "$id" >>"$LOG"
printf '%s\n' "$id"
