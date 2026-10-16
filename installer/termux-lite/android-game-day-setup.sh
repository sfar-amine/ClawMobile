#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$HOME/.openclaw-android/bin:$PATH"
key="samantha:android-resilience-game-day"
runner="$HOME/.openclaw/tier0/bin/android-game-day-run.sh"
existing="$(openclaw cron list --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((j.get("id","") for j in d.get("jobs",[]) if j.get("declarationKey")==sys.argv[1]),""))' "$key" 2>/dev/null || true)"
if [ -n "$existing" ]; then
  openclaw cron edit "$existing" --every 30d --timeout-seconds 2100 --no-output-timeout-seconds 2100 --no-deliver >/dev/null
  printf 'Android game day reconciled: %s\n' "$existing"
else
  openclaw cron add \
    --declaration-key "$key" \
    --name "Android resilience game day" \
    --description "Monthly bounded I10 exercise: Gateway kill -9, guarded network cut, ADB loss, then mini-postmortem in the learning gate." \
    --every 30d \
    --command-argv "[\"$runner\"]" \
    --timeout-seconds 2100 \
    --no-output-timeout-seconds 2100 \
    --no-deliver >/dev/null
  printf 'Android game day installed.\n'
fi
