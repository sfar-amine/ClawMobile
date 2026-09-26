#!/data/data/com.termux/files/usr/bin/bash
set -u
FILE="$HOME/.openclaw/continuity/chatgpt-current.json"
LOG="$HOME/.openclaw/continuity/restore.log"
SERIAL="${CLAWMOBILE_ADB_SERIAL:-127.0.0.1:5556}"
mkdir -p "$(dirname "$FILE")"
[ -s "$FILE" ] || exit 0
id="$(sed -n 's/.*"conversationId":[[:space:]]*"\([^"]*\)".*/\1/p' "$FILE" | head -1)"
mode="$(sed -n 's/.*"mode":[[:space:]]*"\([^"]*\)".*/\1/p' "$FILE" | head -1)"
case "$id" in *[!A-Za-z0-9_-]*|'') printf '%s invalid checkpoint\n' "$(date -Iseconds)" >>"$LOG"; exit 1;; esac
if ! adb -s "$SERIAL" get-state 2>/dev/null | grep -qx device; then
  printf '%s restore=pending reason=adb_unavailable mode=%s\n' "$(date -Iseconds)" "$mode" >>"$LOG"; exit 0
fi
uri="https://chatgpt.com/c/$id"
adb -s "$SERIAL" shell am start -a android.intent.action.VIEW -d "$uri" com.openai.chatgpt >/dev/null 2>&1 || {
  printf '%s restore=failed reason=open_uri mode=%s\n' "$(date -Iseconds)" "$mode" >>"$LOG"; exit 1; }
sleep 2
adb -s "$SERIAL" shell uiautomator dump /sdcard/samantha-continuity.xml >/dev/null 2>&1 || true
xml="$(adb -s "$SERIAL" shell cat /sdcard/samantha-continuity.xml 2>/dev/null || true)"
if ! printf '%s\n' "$xml" | grep -q 'package="com.openai.chatgpt"'; then
  printf '%s restore=failed reason=chatgpt_not_foreground mode=%s\n' "$(date -Iseconds)" "$mode" >>"$LOG"; exit 1
fi
printf '%s restore=verified mode=%s id=%s\n' "$(date -Iseconds)" "$mode" "$id" >>"$LOG"
# Voice activation remains owned by the verified voice-recovery path.
