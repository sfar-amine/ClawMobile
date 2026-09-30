#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${CLAW_SLACK_STATE_DIR:-$HOME/.openclaw/remote-bridge/slack}"
CONFIG="$BASE/config.json"
SECRETS="$BASE/secrets"
USER_TOKEN_FILE="$SECRETS/user-token"
PURGE_TIMEOUT_SECONDS="${CLAW_SLACK_PURGE_TIMEOUT_SECONDS:-240}"

if ! [[ "$PURGE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$PURGE_TIMEOUT_SECONDS" -lt 30 ]; then
  echo "Invalid CLAW_SLACK_PURGE_TIMEOUT_SECONDS: $PURGE_TIMEOUT_SECONDS" >&2
  exit 2
fi

mkdir -p "$SECRETS"
chmod 700 "$HOME/.openclaw/remote-bridge" "$BASE" "$SECRETS" 2>/dev/null || true
umask 077

if [ ! -f "$CONFIG" ]; then
  echo "Slack bridge config missing: $CONFIG" >&2
  exit 2
fi

read -r -s -p "Slack user token for purge (xoxp-...): " user_token
printf '\n'
case "$user_token" in
  xoxp-*) ;;
  *) echo "Invalid user token prefix." >&2; exit 2 ;;
esac

printf '%s' "$user_token" >"$USER_TOKEN_FILE"
chmod 600 "$USER_TOKEN_FILE"
unset user_token

python3 - "$CONFIG" "$USER_TOKEN_FILE" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1])
d=json.loads(p.read_text())
d["userTokenFile"]=sys.argv[2]
p.write_text(json.dumps(d,indent=2)+"\n")
PY
chmod 600 "$CONFIG"

echo "Running purge dry-run..."
"$HOME/.openclaw-android/bin/node" "$ROOT/claw-slack-purge.mjs" --dry-run

export PATH="$HOME/.openclaw-android/bin:$PATH"
existing="$(openclaw cron list --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((j.get("id","") for j in d.get("jobs",[]) if j.get("declarationKey")=="samantha:slack-control-purge"),""))' 2>/dev/null || true)"
if [ -n "$existing" ]; then
  openclaw cron edit "$existing" \
    --timeout-seconds "$PURGE_TIMEOUT_SECONDS" \
    --no-output-timeout-seconds "$PURGE_TIMEOUT_SECONDS" >/dev/null
  echo "Slack purge job reconciled: $existing timeout=${PURGE_TIMEOUT_SECONDS}s"
else
  openclaw cron add \
    --declaration-key "samantha:slack-control-purge" \
    --name "Slack Control Purge" \
    --description "Hourly housekeeping for completed Claw RPC messages older than 24h in the dedicated Slack control channel." \
    --every 1h \
    --command-argv "[\"$HOME/.openclaw-android/bin/node\",\"$ROOT/claw-slack-purge.mjs\"]" \
    --timeout-seconds "$PURGE_TIMEOUT_SECONDS" \
    --no-output-timeout-seconds "$PURGE_TIMEOUT_SECONDS" \
    --no-deliver >/dev/null
  echo "Slack purge job installed with timeout=${PURGE_TIMEOUT_SECONDS}s."
fi

echo "Slack purge setup complete."
