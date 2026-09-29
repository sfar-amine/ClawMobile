#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

BASE="${CLAW_SLACK_STATE_DIR:-$HOME/.openclaw/remote-bridge/slack}"
SECRETS="$BASE/secrets"
CONFIG="$BASE/config.json"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$SECRETS"
chmod 700 "$HOME/.openclaw/remote-bridge" "$BASE" "$SECRETS" 2>/dev/null || true
umask 077

read -r -p "Slack channel ID (C...): " channel_id
read -r -p "Slack owner user ID (U...): " user_id
read -r -s -p "Slack app-level token (xapp-...): " app_token
printf '\n'
read -r -s -p "Slack bot token (xoxb-...): " bot_token
printf '\n'

case "$channel_id" in C*) ;; *) echo "Invalid channel ID." >&2; exit 2;; esac
case "$user_id" in U*) ;; *) echo "Invalid user ID." >&2; exit 2;; esac
case "$app_token" in xapp-*) ;; *) echo "Invalid app token prefix." >&2; exit 2;; esac
case "$bot_token" in xoxb-*) ;; *) echo "Invalid bot token prefix." >&2; exit 2;; esac

printf '%s' "$app_token" >"$SECRETS/app-token"
printf '%s' "$bot_token" >"$SECRETS/bot-token"
chmod 600 "$SECRETS/app-token" "$SECRETS/bot-token"

python3 - "$CONFIG" "$channel_id" "$user_id" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1])
p.write_text(json.dumps({
    "mode":"shadow",
    "channelId":sys.argv[2],
    "allowedUserIds":[sys.argv[3]],
    "appTokenFile":"~/.openclaw/remote-bridge/slack/secrets/app-token",
    "botTokenFile":"~/.openclaw/remote-bridge/slack/secrets/bot-token",
},indent=2)+"\n")
PY
chmod 600 "$CONFIG"
unset app_token bot_token

echo "Slack bridge configuration written in shadow mode."
if [ "${CLAW_SLACK_SETUP_NO_START:-0}" = "1" ]; then
  exit 0
fi
echo "Health before start:"
"$ROOT/claw-slack-bridge-health.py" || true
if ! pgrep -f '[c]law-slack-bridge.mjs' >/dev/null 2>&1; then
  nohup "$ROOT/claw-slack-bridge.sh" >>"$HOME/.openclaw/health/slack_bridge.stderr.log" 2>&1 </dev/null &
fi
sleep 3
echo "Health after start:"
"$ROOT/claw-slack-bridge-health.py" || true
