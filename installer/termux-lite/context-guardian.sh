#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"
D="$HOME/.openclaw/context-sync"; S="$D/state"; LOG="$D/context-guardian.log"
mkdir -p "$D" "$S"; chmod 700 "$D" "$S"
exec 9>"$D/context-guardian.lock"; flock -n 9 || exit 0
log(){ printf '%s component=context-guardian %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
health="$S/health.json"
tmp="$health.tmp.$$"
sessions_json="$(timeout 15 openclaw sessions --json --limit all 2>/dev/null || true)"
if [ -n "$sessions_json" ]; then
  printf '%s' "$sessions_json" | python3 -c '
import json,sys,time
d=json.load(sys.stdin); now=int(time.time()*1000)
rows=[]
for s in d.get("sessions",[]):
    ct=s.get("contextTokens") or 0; tt=s.get("totalTokens") or 0
    ratio=(tt/ct) if ct and isinstance(tt,(int,float)) else None
    rows.append({"key":s.get("key"),"sessionId":s.get("sessionId"),"updatedAt":s.get("updatedAt"),"totalTokens":tt,"contextTokens":ct,"ratio":ratio,"kind":s.get("kind"),"status":s.get("status")})
print(json.dumps({"version":1,"checkedAtMs":now,"sessions":rows},separators=(",",":")))
' >"$tmp" 2>/dev/null && mv "$tmp" "$health"
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
