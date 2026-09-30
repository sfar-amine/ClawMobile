#!/data/data/com.termux/files/usr/bin/bash
set -u
cd "$HOME" || exit 70
MAX_DIAG_FAILURES="${INCIDENT_MAX_DIAG_FAILURES:-2}"
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"; DB="$HOME/.openclaw/incidents/orchestrator.db"; LOG="$HOME/.openclaw/incidents/orchestrator-worker.log"
mkdir -p "$(dirname "$LOG")"; exec 9>"$HOME/.openclaw/incidents/orchestrator-worker.lock"; flock -n 9 || exit 0
log(){ printf '%s component=incident-orchestrator %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
while :; do
  printf '%s' "$(date +%s)" >"$HOME/.openclaw/health/incident-orchestrator.heartbeat"
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
    case "$component" in
      adb|gateway-secretref-exec|openclaw-agent-headless|remote_desktop) ;;
      *)
        "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "no enabled managed repair handler" >/dev/null 2>&1 || true
        log "incident=$iid component=$component terminal=failed reason=no_managed_handler"
        sleep 5
        continue
        ;;
    esac
    log "incident=$iid component=$component action=diagnose"
    if "$ROOT/autonomous-engineering-shadow.sh" "$component" 3 "$iid"; then
      log "incident=$iid component=$component diagnosis=completed"
      if [ "$component" = remote_desktop ]; then
        action=$(python3 - "$HOME/.openclaw/autonomous-engineering/shadow/$iid.json" <<'PY3'
import json,sys
try: print(((json.load(open(sys.argv[1])).get("diagnosis") or {}).get("recommended_action_id")) or "")
except Exception: print("")
PY3
)
        case "$action" in
          runtime.managed_repair|diagnostics.collect_more)
            "$ROOT/incident-orchestrator.py" transition "$iid" planning --source orchestrator-worker --reason "approved model recommendation: $action" >/dev/null 2>&1 || true
            ;;
          *)
            "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "model diagnosis produced no enabled managed action" >/dev/null 2>&1 || true
            ;;
        esac
      fi
    else
      "$ROOT/incident-orchestrator.py" observe "$iid" diagnosis_failed --source orchestrator-worker --json '{"bounded":true}' >/dev/null 2>&1 || true
      count=$(python3 - "$DB" "$iid" <<'PY3'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);print(c.execute("select count(*) from events where incident_id=? and kind='diagnosis_failed'",(sys.argv[2],)).fetchone()[0])
PY3
)
      if [ "$count" -ge "$MAX_DIAG_FAILURES" ]; then
        "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "bounded model diagnosis budget exhausted" >/dev/null 2>&1 || true
        log "incident=$iid component=$component terminal=failed reason=model_diagnosis_budget"
      else
        log "incident=$iid component=$component diagnosis=failed count=$count/$MAX_DIAG_FAILURES"
        sleep 15
      fi
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
        if "$ROOT/incident-orchestrator.py" recover "$component" "$scope" --source orchestrator-worker --reason "gateway SecretRef resolver verified without persisted secret" >/dev/null 2>&1; then
          log "incident=$iid component=$component terminal=recovered handler=secure_secretref_exec"
        else
          log "incident=$iid component=$component state=verifying result=recover_transition_failed"
        fi
      else
        "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "managed SecretRef repair verification failed" >/dev/null 2>&1 || true
      fi
    elif [ "$component" = remote_desktop ]; then
      action=$(python3 - "$DB" "$iid" <<'PY3'
import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
r=c.execute("select payload from events where incident_id=? and kind='diagnosis' order by seq desc limit 1",(sys.argv[2],)).fetchone()
try: print((json.loads(r[0]).get("recommended_action_id") if r else "") or "")
except Exception: print("")
PY3
)
      if [ "$action" = diagnostics.collect_more ]; then
        count=$(python3 - "$DB" "$iid" <<'PY3'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);print(c.execute("select count(*) from events where incident_id=? and kind='diagnostics_collected'",(sys.argv[2],)).fetchone()[0])
PY3
)
        if [ "$count" -ge 1 ]; then
          "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "remote desktop diagnostic budget exhausted" >/dev/null 2>&1 || true
          log "incident=$iid component=$component terminal=failed reason=diagnostic_budget"
        else
          ev=$(python3 - <<'PY3'
import json,pathlib,subprocess
p=pathlib.Path.home()/".openclaw/watchdogs/remote-desktop-process.log"
tail=p.read_text(errors="replace").splitlines()[-24:] if p.exists() else []
q=subprocess.run(["pgrep","-af","@wonderwhy-er/desktop-commander/dist/index.js remote"],capture_output=True,text=True)
print(json.dumps({"process_rc":q.returncode,"processes":q.stdout[-1200:],"recent_log":tail},separators=(",",":")))
PY3
)
          "$ROOT/incident-orchestrator.py" observe "$iid" diagnostics_collected --source orchestrator-worker --json "$ev" >/dev/null 2>&1 || true
          "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source orchestrator-worker --reason "bounded remote desktop diagnostics collected" >/dev/null 2>&1 || true
          log "incident=$iid component=$component action=collect_more result=done"
        fi
      elif [ "$action" = runtime.managed_repair ]; then
        "$ROOT/incident-orchestrator.py" transition "$iid" repairing --source orchestrator-worker --reason "approved managed runtime repair" >/dev/null 2>&1 || true
        f="$HOME/.openclaw/watchdogs/remote-desktop-process.log"
        pkill -TERM -f '@wonderwhy-er/desktop-commander/dist/index.js remote' 2>/dev/null || true
        sleep 2
        size=$(wc -c <"$f" 2>/dev/null || echo 0)
        if [ "$size" -gt 4194304 ]; then tail -c 1048576 "$f" >"$f.tmp" && mv "$f.tmp" "$f"; fi
        before=$(wc -c <"$f" 2>/dev/null || echo 0)
        cd "$HOME" || exit 70
        nohup "$HOME/.openclaw-android/bin/node" /data/data/com.termux/files/usr/lib/node_modules/@wonderwhy-er/desktop-commander/dist/index.js remote 9>&- >>"$f" 2>&1 </dev/null &
        sleep 8
        if pgrep -f '@wonderwhy-er/desktop-commander/dist/index.js remote' >/dev/null 2>&1 \
          && tail -c +$((before+1)) "$f" | grep -q '^[[:space:]]*- 🔌 Connected to Remote MCP' \
          && tail -c +$((before+1)) "$f" | grep -Eq '^[[:space:]]*(✅ Device ready:|- 🔌 Connected to Desktop Commander MCP)'; then
          "$ROOT/incident-orchestrator.py" transition "$iid" verifying --source orchestrator-worker --reason "managed Remote Desktop restart is ready" >/dev/null 2>&1 || true
          "$ROOT/incident-orchestrator.py" recover "$component" "$scope" --source orchestrator-worker --reason "Remote Desktop managed restart verified from stable cwd" >/dev/null 2>&1 || true
          log "incident=$iid component=$component terminal=recovered handler=remote_desktop_stable_cwd"
        else
          "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "managed Remote Desktop repair verification failed" >/dev/null 2>&1 || true
          log "incident=$iid component=$component terminal=failed handler=remote_desktop_stable_cwd"
        fi
      else
        "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "remote desktop planning action not enabled" >/dev/null 2>&1 || true
      fi
    elif [ "$component" = openclaw-agent-headless ]; then
      if "$ROOT/openclaw-headless-smoke.sh" >/dev/null 2>&1; then
        "$ROOT/incident-orchestrator.py" transition "$iid" verifying --source orchestrator-worker --reason "headless profile regenerated with plugins disabled and bounded model policy" >/dev/null 2>&1 || true
        if "$ROOT/incident-orchestrator.py" recover "$component" "$scope" --source orchestrator-worker --reason "headless agent smoke verified end-to-end" >/dev/null 2>&1; then
          "$ROOT/capability-recovered.py" openclaw.agent.headless >/dev/null 2>&1 || true
          log "incident=$iid component=$component terminal=recovered handler=headless_profile_smoke"
        else
          log "incident=$iid component=$component state=verifying result=recover_transition_failed"
        fi
      else
        "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "managed headless smoke verification failed" >/dev/null 2>&1 || true
      fi
    else
      "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "no enabled managed repair handler" >/dev/null 2>&1 || true
    fi
  fi
done
