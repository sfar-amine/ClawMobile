#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
TIER0="$HOME/.openclaw/tier0"
CONTROL="$TIER0/bin/tier0-control.py"
ROOT="$("$CONTROL" root)"
PROBE="$ROOT/claw-slack-bridge-health.py"
BRIDGE="$ROOT/claw-slack-bridge.sh"
COMPANION="$ROOT/companion-server.sh"
COMPANION_URL="http://127.0.0.1:8765/v1/health"
LOG="$HOME/.openclaw/remote-bridge/primary-repair.log"
mkdir -p "$(dirname "$LOG")"
log(){ printf '%s component=primary-repair %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
companion_healthy(){ timeout 3 curl -fsS "$COMPANION_URL" >/dev/null 2>&1; }

if ! companion_healthy; then
  log 'action=restart_companion'
  pkill -TERM -f 'dist/companion/[s]erver.js' 2>/dev/null || true
  sleep 2
  nohup "$COMPANION" >>"$HOME/.openclaw/health/companion.stderr.log" 2>&1 </dev/null &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    companion_healthy && break
    sleep 2
  done
fi

if companion_healthy && "$PROBE" >/dev/null 2>&1; then
  log 'result=already_healthy'
  echo PRIMARY_HEALTHY
  exit 0
fi

log 'action=restart_slack_bridge'
pkill -TERM -f '[c]law-slack-bridge.mjs' 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8; do
  pgrep -f '[c]law-slack-bridge.mjs' >/dev/null 2>&1 || break
  sleep 1
done
pgrep -f '[c]law-slack-bridge.mjs' >/dev/null 2>&1 && pkill -KILL -f '[c]law-slack-bridge.mjs' 2>/dev/null || true
nohup "$BRIDGE" >>"$HOME/.openclaw/health/slack_bridge.stderr.log" 2>&1 </dev/null &
sleep 5
if companion_healthy && "$PROBE" >/dev/null 2>&1; then
  log 'result=repaired'
  echo PRIMARY_REPAIRED
  exit 0
fi
log 'result=failed'
echo PRIMARY_REPAIR_FAILED >&2
exit 1
