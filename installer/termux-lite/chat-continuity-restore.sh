#!/data/data/com.termux/files/usr/bin/bash
set -u
FILE="$HOME/.openclaw/continuity/chatgpt-current.json"
LOG="$HOME/.openclaw/continuity/restore.log"
mkdir -p "$(dirname "$FILE")"
[ -s "$FILE" ] || exit 0
id="$(sed -n 's/.*"conversationId":[[:space:]]*"\([^"]*\)".*/\1/p' "$FILE" | head -1)"
mode="$(sed -n 's/.*"mode":[[:space:]]*"\([^"]*\)".*/\1/p' "$FILE" | head -1)"
case "$id" in *[!A-Za-z0-9_-]*|'') printf '%s invalid checkpoint\n' "$(date -Iseconds)" >>"$LOG"; exit 1;; esac
# Recovery is deferred until an authorized ADB device exists. Never guess another chat.
if ! adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{ok=1} END{exit !ok}'; then
  printf '%s restore=pending reason=adb_unavailable mode=%s\n' "$(date -Iseconds)" "$mode" >>"$LOG"
  exit 0
fi
uri="https://chatgpt.com/c/$id"
adb shell am start -a android.intent.action.VIEW -d "$uri" com.openai.chatgpt >/dev/null 2>&1 || {
  printf '%s restore=failed reason=open_uri mode=%s\n' "$(date -Iseconds)" "$mode" >>"$LOG"; exit 1; }
printf '%s restore=opened mode=%s\n' "$(date -Iseconds)" "$mode" >>"$LOG"
# Voice activation is deliberately left to Companion's verified voice-recovery path.
