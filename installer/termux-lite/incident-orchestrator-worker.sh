#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"; DB="$HOME/.openclaw/incidents/orchestrator.db"; LOG="$HOME/.openclaw/incidents/orchestrator-worker.log"
mkdir -p "$(dirname "$LOG")"; exec 9>"$HOME/.openclaw/incidents/orchestrator-worker.lock"; flock -n 9 || exit 0
log(){ printf '%s component=incident-orchestrator %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
while :; do
  row=$(python3 - "$DB" <<'PY'
import sqlite3,sys
try:
 c=sqlite3.connect(sys.argv[1]);r=c.execute("select id,component,scope,state from incidents where state in ('detected','diagnosing','planning') order by updated limit 1").fetchone()
 print("|".join(map(str,r)) if r else "")
except Exception: print("")
PY
)
  if [ -z "$row" ]; then sleep 5; continue; fi
  IFS='|' read -r iid component scope state <<EOF
$row
EOF
  if [ "$state" = detected ]; then
    "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source orchestrator-worker --reason "deterministic recovery exhausted" >/dev/null 2>&1 || true
    log "incident=$iid component=$component transition=diagnosing"; continue
  fi
  if [ "$state" = diagnosing ]; then
    log "incident=$iid component=$component action=diagnose"
    if "$ROOT/autonomous-engineering-shadow.sh" "$component" 3 "$iid"; then
      log "incident=$iid component=$component diagnosis=completed"
    else
      "$ROOT/incident-orchestrator.py" observe "$iid" diagnosis_failed --source orchestrator-worker --json '{"bounded":true}' >/dev/null 2>&1 || true
      log "incident=$iid component=$component diagnosis=failed"
      sleep 15
    fi
    continue
  fi
  if [ "$state" = planning ]; then
    # Only read-only diagnostics are executable at this stage. Mutation remains gated.
    if [ "$component" = adb ]; then
      ev=$(python3 - <<'PY'
import json,subprocess
cmds=[["adb","devices"],["getprop","sys.boot_completed"],["dumpsys","wifi"]]
out={}
for c in cmds:
 try:
  p=subprocess.run(c,capture_output=True,text=True,timeout=5);out[" ".join(c)]={"rc":p.returncode,"stdout":p.stdout[-1200:],"stderr":p.stderr[-400:]}
 except Exception as e: out[" ".join(c)]={"error":type(e).__name__}
print(json.dumps(out,separators=(",",":")))
PY
)
      "$ROOT/incident-orchestrator.py" observe "$iid" diagnostics_collected --source orchestrator-worker --json "$ev" >/dev/null 2>&1 || true
      "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source orchestrator-worker --reason "read-only diagnostics collected" >/dev/null 2>&1 || true
      log "incident=$iid component=$component action=collect_more result=done"
    else
      sleep 15
    fi
  fi
done
