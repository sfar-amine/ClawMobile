#!/data/data/com.termux/files/usr/bin/bash
set -u
umask 077
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"
D="$HOME/.openclaw/context-sync"; S="$D/state"; LOG="$D/context-guardian.log"
mkdir -p "$D" "$S"; chmod 700 "$D" "$S"
exec 9>"$D/context-guardian.lock"; flock -n 9 || exit 0
log(){ printf '%s component=context-guardian %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
health="$S/health.json"
tmp="$health.tmp.$$"
if python3 "$ROOT/context-guardian-read.py" --agents-root "$HOME/.openclaw/agents" >"$tmp" 2>/dev/null; then
  mv "$tmp" "$health"
else
  rm -f "$tmp"
  log "event=session_read state=unavailable source=agent_sqlite"
fi
# Native OpenClaw safeguard compaction is authoritative for session-window pressure.
# This guardian observes; it does not compact arbitrary sessions behind active turns.
if [ -s "$health" ]; then
  warn="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for s in d["sessions"] if s.get("ratio") is not None and s["ratio"]>=0.60))' "$health" 2>/dev/null || echo 0)"
  hard="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for s in d["sessions"] if s.get("ratio") is not None and s["ratio"]>=0.80))' "$health" 2>/dev/null || echo 0)"
  log "event=session_pressure result=ok soft_ge_60=$warn hard_ge_80=$hard"
fi
# Hybrid checkpoint freshness: warn if active Claw work exists but durable checkpoint is stale.
hybrid="$HOME/.openclaw/workspace/context/HYBRID_CONTEXT.md"
if [ -f "$hybrid" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$hybrid") ))
  printf '%s\n' "$age" >"$S/hybrid_age_seconds"
  [ "$age" -gt 1800 ] && log "event=hybrid_freshness state=stale age_s=$age"
fi
date -Iseconds >"$S/last_success"
