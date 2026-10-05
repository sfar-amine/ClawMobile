#!/data/data/com.termux/files/usr/bin/bash
set -u
cd "$HOME" || exit 70
MAX_DIAG_FAILURES="${INCIDENT_MAX_DIAG_FAILURES:-2}"
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"; DB="$HOME/.openclaw/incidents/orchestrator.db"; LOG="$HOME/.openclaw/incidents/orchestrator-worker.log"
mkdir -p "$(dirname "$LOG")"; exec 9>"$HOME/.openclaw/incidents/orchestrator-worker.lock"; flock -n 9 || exit 0
log(){ printf '%s component=incident-orchestrator %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
# Keep supervisor liveness observable while a bounded engineering subprocess is running.
run_observed(){
  "$@" 9>&- &
  child=$!
  while kill -0 "$child" 2>/dev/null; do
    printf '%s' "$(date +%s)" >"$HOME/.openclaw/health/incident-orchestrator.heartbeat"
    sleep 2 9>&-
  done
  wait "$child"
}
# Perform the non-destructive schema migration before the selection loop.
python3 - "$ROOT/incident-orchestrator.py" <<'PY_INIT'
import importlib.util,sys
spec=importlib.util.spec_from_file_location("orch",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.connect().close()
PY_INIT
while :; do
  printf '%s' "$(date +%s)" >"$HOME/.openclaw/health/incident-orchestrator.heartbeat"
  row=$(python3 - "$DB" <<'PY'
import sqlite3,sys,time
try:
 c=sqlite3.connect(sys.argv[1]);r=c.execute("select id,component,scope,state from incidents where state in ('detected','diagnosing','planning','repairing') or (state='waiting_model' and next_retry<=?) order by updated limit 1",(time.time(),)).fetchone()
 print("|".join(map(str,r)) if r else "")
except Exception: print("")
PY
)
  if [ -z "$row" ]; then sleep 5; continue; fi
  IFS='|' read -r iid component scope state <<EOF
$row
EOF
  if [ "$state" = waiting_model ]; then
    "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source orchestrator-worker --reason "bounded model retry due; checkpoint preserved" >/dev/null 2>&1 || true
    continue
  fi
  if [ "$state" = detected ]; then
    "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source orchestrator-worker --reason "deterministic recovery exhausted" >/dev/null 2>&1 || true
    log "incident=$iid component=$component transition=diagnosing"; continue
  fi
  if [ "$state" = diagnosing ] || [ "$state" = planning ] || [ "$state" = repairing ]; then
    if "$ROOT/engineering-repair.sh" supports "$component" >/dev/null 2>&1; then
      if [ "$state" = diagnosing ]; then
        "$ROOT/incident-orchestrator.py" transition "$iid" planning --source orchestrator-worker --reason "trusted repair profile resolved" >/dev/null 2>&1 || true
        continue
      fi
      if [ "$state" = planning ]; then
        "$ROOT/incident-orchestrator.py" transition "$iid" repairing --source orchestrator-worker --reason "isolated code repair using fixed acceptance contract" >/dev/null 2>&1 || true
      fi
      result="$HOME/.openclaw/autonomous-engineering/shadow/$iid.repair.json"
      mkdir -p "$(dirname "$result")"
      if run_observed timeout -k 10 420 "$ROOT/engineering-repair.sh" run "$iid" >"$result.tmp" 2>"$result.stderr"; then rc=0; else rc=$?; fi
      if [ "$rc" -eq 0 ] && python3 -m json.tool "$result.tmp" >/dev/null 2>&1; then
        mv "$result.tmp" "$result"
      else
        # Launcher/format failures are not provider unavailability.
        python3 - "$result" "$rc" <<'PY_FAILURE'
import json,sys
rc=int(sys.argv[2]); status='interrupted' if rc in (124,137) else 'controller_invalid_output' if rc==0 else 'controller_launch_failed' if rc in (125,126,127) else 'controller_failed'
with open(sys.argv[1],'w') as f: json.dump({'status':status,'exit_code':rc,'reason':status},f)
PY_FAILURE
        rm -f "$result.tmp"
      fi
      "$ROOT/engineering-incident-result.py" "$iid" "$result" >/dev/null 2>&1 || true
      continue
    fi
  fi
  if [ "$state" = repairing ] && [ "$component" = remote_desktop ]; then
    # Resume by verifying an interrupted effect, never replaying the managed restart.
    if python3 "$ROOT/remote-desktop-control.py" health >/dev/null; then
      "$ROOT/incident-orchestrator.py" recover "$component" "$scope" --source orchestrator-worker --reason "interrupted RDC repair independently verified; no replay" >/dev/null 2>&1 || true
    else
      "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "interrupted RDC repair effect unverified; no automatic replay" >/dev/null 2>&1 || true
    fi
    continue
  fi
  if [ "$state" = repairing ]; then
    "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "no registered resumable repair profile" >/dev/null 2>&1 || true
    continue
  fi
  if [ "$state" = diagnosing ]; then
    if [ "$component" = adb ]; then
      # Fresh canonical ADB proof supersedes stale boot-continuity diagnosis.
      if timeout 3 adb -s 127.0.0.1:5556 get-state 2>/dev/null | grep -qx device; then
        "$ROOT/incident-orchestrator.py" transition "$iid" verifying --source orchestrator-worker --reason "canonical ADB transport recovered during diagnosis" >/dev/null 2>&1 || true
        "$ROOT/incident-orchestrator.py" recover "$component" "$scope" --source orchestrator-worker --reason "canonical 127.0.0.1:5556 ADB transport independently verified" >/dev/null 2>&1 || true
        log "incident=$iid component=$component terminal=recovered handler=adb_live_precheck"
        continue
      fi
      # Reuse the validated bounded diagnostics action instead of replaying model diagnosis.
      reuse=$(python3 - "$DB" "$iid" <<'PY_ADB_REUSE'
import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
diagnosis=c.execute("select payload from events where incident_id=? and kind='diagnosis' order by seq desc limit 1",(sys.argv[2],)).fetchone()
count=c.execute("select count(*) from events where incident_id=? and kind='diagnostics_collected'",(sys.argv[2],)).fetchone()[0]
try:
    action=(json.loads(diagnosis[0]).get("recommended_action_id") if diagnosis else "") or ""
except Exception:
    action=""
print("yes" if count >= 1 and action == "diagnostics.collect_more" else "no")
PY_ADB_REUSE
)
      if [ "$reuse" = yes ]; then
        "$ROOT/incident-orchestrator.py" transition "$iid" planning --source orchestrator-worker --reason "reuse verified bounded diagnostics action; no model replay" >/dev/null 2>&1 || true
        log "incident=$iid component=$component transition=planning source=verified_diagnostics_reuse"
        continue
      fi
    fi
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
    if run_observed "$ROOT/autonomous-engineering-shadow.sh" "$component" 3 "$iid"; then
      # Re-read canonical state before applying any delayed model recommendation.
      current=$(python3 - "$DB" "$iid" <<'PY_CURRENT'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);r=c.execute('select state from incidents where id=?',(sys.argv[2],)).fetchone();print(r[0] if r else 'missing')
PY_CURRENT
)
      case "$current" in recovered|failed|human_required|missing) log "incident=$iid model_result=late_no_action"; continue;; esac
      shadow_result="$HOME/.openclaw/autonomous-engineering/shadow/$iid.json"
      model_status=$(python3 - "$shadow_result" <<'PY_STATUS'
import json,sys
try: print(str(json.load(open(sys.argv[1])).get("status") or "invalid_output"))
except Exception: print("invalid_output")
PY_STATUS
)
      if [ "$model_status" != success ]; then
        if "$ROOT/engineering-incident-result.py" "$iid" "$shadow_result" >/dev/null 2>&1; then
          log "incident=$iid component=$component diagnosis=non_success status=$model_status action=canonicalize"
        else
          "$ROOT/incident-orchestrator.py" transition "$iid" failed --source orchestrator-worker --reason "non-success model result could not be canonicalized" >/dev/null 2>&1 || true
          log "incident=$iid component=$component terminal=failed reason=model_result_canonicalization"
        fi
        continue
      fi
      log "incident=$iid component=$component diagnosis=completed"
      if [ "$component" = remote_desktop ]; then
        action=$(python3 - "$HOME/.openclaw/autonomous-engineering/shadow/$iid.json" <<'PY3'
import json,sys
try:
 d=json.load(open(sys.argv[1])); valid=d.get('status')=='success' and d.get('model_verified') is True
 print(((d.get("diagnosis") or {}).get("recommended_action_id") or "") if valid else "")
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
          ev=$(python3 "$ROOT/remote-desktop-control.py" diagnostics)
          "$ROOT/incident-orchestrator.py" observe "$iid" diagnostics_collected --source orchestrator-worker --json "$ev" >/dev/null 2>&1 || true
          "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source orchestrator-worker --reason "bounded remote desktop diagnostics collected" >/dev/null 2>&1 || true
          log "incident=$iid component=$component action=collect_more result=done"
        fi
      elif [ "$action" = runtime.managed_repair ]; then
        "$ROOT/incident-orchestrator.py" transition "$iid" repairing --source orchestrator-worker --reason "approved managed runtime repair" >/dev/null 2>&1 || continue
        # Shared serialization/cleanup/readiness primitive; never duplicate watchdog effects.
        result="$HOME/.openclaw/autonomous-engineering/shadow/$iid.rdc-repair.json"
        if run_observed python3 "$ROOT/remote-desktop-control.py" repair >"$result" \
          && python3 "$ROOT/remote-desktop-control.py" health >/dev/null; then
          "$ROOT/incident-orchestrator.py" transition "$iid" verifying --source orchestrator-worker --reason "managed Remote Desktop functional checks passed" >/dev/null 2>&1 || true
          "$ROOT/incident-orchestrator.py" recover "$component" "$scope" --source orchestrator-worker --reason "Remote Desktop singleton, local MCP ping and remote heartbeat verified" >/dev/null 2>&1 || true
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
