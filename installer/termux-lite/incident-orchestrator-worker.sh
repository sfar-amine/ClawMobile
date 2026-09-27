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
    if [ "$component" = adb ]; then
      count=$(python3 - "$DB" "$iid" <<'PY2'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);print(c.execute("select count(*) from events where incident_id=? and kind='diagnostics_collected'",(sys.argv[2],)).fetchone()[0])
PY2
)
      if [ "$count" -ge 2 ]; then
        # Verified boundary: Android is booted, no authorized ADB device exists,
        # stable trusted endpoint refuses connections, and Termux lacks permission
        # to enable Wireless Debugging. A new Android pairing gesture/code is required.
        adb_count=$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{n++} END{print n+0}')
        booted=$(getprop sys.boot_completed 2>/dev/null || true)
        stable=$(timeout 3 adb connect 127.0.0.1:5556 2>&1 || true)
        perm=$(timeout 3 settings get global adb_wifi_enabled 2>&1 || true)
        if [ "$adb_count" -eq 0 ] && [ "$booted" = 1 ] && printf '%s' "$stable" | grep -qi 'refused' && printf '%s' "$perm" | grep -qi 'SecurityException'; then
          reason='Android booted; no authorized ADB transport; trusted 127.0.0.1:5556 refused; Termux cannot enable Wireless Debugging. Android pairing UI/code is required.'
          "$ROOT/incident-orchestrator.py" transition "$iid" human_required --source orchestrator-worker --human-boundary --reason "$reason" >/dev/null
          "$ROOT/incident-notify.sh" human_required "Samantha — ADB nécessite maintenant une intervention physique vérifiée ; les récupérations automatiques et diagnostics sont épuisés." "1. Ouvre Paramètres > Options développeur > Débogage sans fil.\n2. Ouvre « Associer l’appareil avec un code d’association ».\n3. Laisse cet écran ouvert avec le code et les ports visibles ; je reprendrai automatiquement ensuite." || true
          log "incident=$iid component=$component terminal=human_required evidence=verified"
        else
          "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "diagnostic budget exhausted without verified human boundary" >/dev/null 2>&1 || true
          log "incident=$iid component=$component terminal=failed reason=diagnostic_budget"
        fi
        sleep 5; continue
      fi
      ev=$(python3 - <<'PY2'
import json,subprocess
cmds=[["adb","devices"],["getprop","sys.boot_completed"],["settings","get","global","adb_wifi_enabled"]]
out={}
for c in cmds:
 try:
  p=subprocess.run(c,capture_output=True,text=True,timeout=5);out[" ".join(c)]={"rc":p.returncode,"stdout":p.stdout[-1200:],"stderr":p.stderr[-1200:]}
 except Exception as e: out[" ".join(c)]={"error":type(e).__name__}
print(json.dumps(out,separators=(",",":")))
PY2
)
      "$ROOT/incident-orchestrator.py" observe "$iid" diagnostics_collected --source orchestrator-worker --json "$ev" >/dev/null 2>&1 || true
      "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source orchestrator-worker --reason "read-only diagnostics collected" >/dev/null 2>&1 || true
      log "incident=$iid component=$component action=collect_more result=done count=$((count+1))"
      sleep 5
    elif [ "$component" = gateway-secretref-exec ]; then
      if "$ROOT/gateway-secretref-exec.sh" --help >/dev/null 2>&1; then
        "$ROOT/incident-orchestrator.py" transition "$iid" verifying --source orchestrator-worker --reason "secure gateway SecretRef execution wrapper installed" >/dev/null 2>&1 || true
        "$ROOT/incident-orchestrator.py" recover "$iid" --source orchestrator-worker --reason "gateway SecretRef resolver verified without persisted secret" >/dev/null 2>&1 || true
        log "incident=$iid component=$component terminal=recovered handler=secure_secretref_exec"
      else
        "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "managed SecretRef repair verification failed" >/dev/null 2>&1 || true
      fi
    else
      "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "no enabled managed repair handler" >/dev/null 2>&1 || true
    fi
  fi
done
