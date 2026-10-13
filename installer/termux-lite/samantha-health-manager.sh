#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"; D="$HOME/.openclaw/health"; LOG="$D/health.log"; S="$D/state"; mkdir -p "$D" "$S"; export TMPDIR="$HOME/.cache/tmp"
PHANTOM_HEADROOM_TARGET=128; PHANTOM_HEADROOM_CHECK_S=60
RESTART_BUDGET_N="${HEALTH_RESTART_BUDGET_N:-3}"
RESTART_WINDOW_S="${HEALTH_RESTART_WINDOW_S:-3600}"
STABILITY_RESET_S="${HEALTH_STABILITY_RESET_S:-600}"
ROLLBACK_GRACE_S="${HEALTH_ROLLBACK_GRACE_S:-120}"
case "$RESTART_BUDGET_N:$RESTART_WINDOW_S:$STABILITY_RESET_S:$ROLLBACK_GRACE_S" in *[!0-9:]*) exit 64;; esac
[ "$RESTART_BUDGET_N" -ge 1 ] && [ "$RESTART_WINDOW_S" -ge 1 ] && [ "$STABILITY_RESET_S" -ge 1 ] && [ "$ROLLBACK_GRACE_S" -ge 1 ] || exit 64
WHATSAPP_READINESS_GRACE_S=120
exec 9>"$D/health.lock"; flock -n 9 || exit 0
log(){ python3 "$ROOT/bounded-log.py" "$LOG" --append "$(date -Iseconds) component=health-manager $*"; }
proc(){ pgrep -f "$1" 9>&- >/dev/null 2>&1; }; http(){ timeout 3 curl -fsS "$1" 9>&- >/dev/null 2>&1; }; adb_ok(){ timeout 3 adb 9>&- -s 127.0.0.1:5556 get-state 2>/dev/null|grep -qx device 9>&-; }
now(){ date +%s; }; sf(){ echo "$S/$1.$2"; }; get(){ cat "$(sf "$1" "$2")" 2>/dev/null || echo "${3:-0}"; }; put(){ printf '%s' "$3" >"$(sf "$1" "$2")"; }
canonical_mode(){ python3 "$ROOT/runtime_mode.py" 9>&- 2>/dev/null || true; }
companion_idle_proven(){ timeout 8 python3 "$ROOT/gateway-memory-guard.py" --idle-proof 9>&- >/dev/null 2>&1; }
unstable(){ put "$1" stable_since 0; }
reset_restart_budget(){
 n="$1"; rm -f "$(sf "$n" restart_attempts)" "$(sf "$n" escalation)" "$(sf "$n" rollback_at)"
 put "$n" failures 0; put "$n" next 0
}
healthy(){
 n="$1"; prev=$(get "$n" status unknown); old=$(get "$n" failures 0); t=$(now); since=$(get "$n" stable_since 0)
 if [ "$prev" != healthy ]; then log "service=$n state=healthy"; put "$n" stable_since "$t"; since="$t"; fi
 put "$n" status healthy
 [ -e "$(sf "$n" failures)" ] || put "$n" failures 0
 [ -e "$(sf "$n" next)" ] || put "$n" next 0
 case "$since" in ''|*[!0-9]*) since="$t"; put "$n" stable_since "$t";; esac
 if [ "$since" -le 0 ]; then since="$t"; put "$n" stable_since "$t"; fi
 if [ $((t-since)) -ge "$STABILITY_RESET_S" ]; then
  [ "$(get "$n" escalation none)" = none ] && [ ! -s "$(sf "$n" restart_attempts)" ] || log "service=$n action=restart_budget_reset stable_s=$((t-since))"
  reset_restart_budget "$n"
 fi
 if { [ "$prev" = degraded ] && [ "$old" -ge 3 ]; } || [ "$prev" = human_required ]; then "$ROOT/incident-orchestrator.py" recover "$n" "$(scope "$n")" --source health-manager --reason "service health verified after recovery" >/dev/null 2>&1 || true; "$ROOT/incident-close.sh" "$n" "Samantha — $n est de nouveau opérationnel et la récupération est vérifiée." || true; fi
}
scope(){ if [ "$1" = adb ]; then printf "boot-%s" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"; else printf runtime; fi; }
incident_open(){ n="$1"; correlation_id="$2"; summary="${3:-$n persistent health failure}"; "$ROOT/incident-orchestrator.py" open "$n" "$(scope "$n")" --source health-manager --summary "$summary" --correlation-id "$correlation_id" --observation-kind probe 2>/dev/null | python3 -c 'import sys,json; row=json.load(sys.stdin); print(row["id"]+"|"+row["correlation_id"])'; }
shadow(){ n="$1"; c="$2"; iid="$3"; nohup "$ROOT/autonomous-engineering-shadow.sh" "$n" "$c" "$iid" 9>&- >>"$D/autonomous-engineering-shadow.stderr.log" 2>&1 </dev/null & }
human_escalate(){
 n="$1"; probe_correlation="probe-$(now)-$$-$n"; opened=$(incident_open "$n" "$probe_correlation") || return 1; IFS='|' read -r iid correlation_id <<EOF
$opened
EOF
 "$ROOT/incident-orchestrator.py" transition "$iid" human_required --source health-manager --reason "Tier0 rollback did not restore $n after the hourly restart budget" --human-boundary >/dev/null 2>&1 || true
 "$ROOT/incident-notify.sh" human_required "Samantha — $n reste indisponible après le budget de relances et le retour arrière Tier0 (incident $iid)." "Vérifier le composant $n et l'incident $iid ; aucune nouvelle relance automatique ne sera tentée avant 10 minutes de stabilité vérifiée." || true
 put "$n" escalation human_required; put "$n" status human_required; log "service=$n state=human_required incident_id=$iid correlation_id=$correlation_id reason=restart_budget_and_rollback_exhausted"
}
restart_gate(){
 n="$1"; t=$(now); state=$(get "$n" escalation none); attempts=$(sf "$n" restart_attempts); tmp="$attempts.tmp.$$"
 put "$n" stable_since 0
 if [ "$state" = human_required ]; then log "service=$n action=restart_refused reason=human_required"; return 1; fi
 if [ "$state" = rolled_back ]; then
  at=$(get "$n" rollback_at 0); case "$at" in ''|*[!0-9]*) at=0;; esac
  if [ $((t-at)) -lt "$ROLLBACK_GRACE_S" ]; then log "service=$n action=restart_refused reason=rollback_grace"; return 1; fi
  human_escalate "$n"; return 1
 fi
 mkdir -p "$S"; : >"$tmp"; count=0
 if [ -f "$attempts" ]; then
  while IFS= read -r stamp; do case "$stamp" in ''|*[!0-9]*) continue;; esac; [ $((t-stamp)) -lt "$RESTART_WINDOW_S" ] || continue; printf '%s\n' "$stamp" >>"$tmp"; count=$((count+1)); done <"$attempts"
 fi
 if [ "$count" -lt "$RESTART_BUDGET_N" ]; then printf '%s\n' "$t" >>"$tmp"; mv "$tmp" "$attempts"; log "service=$n action=restart_authorized budget=$((count+1))/$RESTART_BUDGET_N window_s=$RESTART_WINDOW_S"; return 0; fi
 rm -f "$tmp"; log "service=$n action=tier0_rollback reason=restart_budget_exhausted budget=$count/$RESTART_BUDGET_N"
 if "$HOME/.openclaw/tier0/bin/tier0-control.py" rollback --reason "health_restart_budget_exhausted:$n" 9>&- >/dev/null 2>&1; then
  put "$n" escalation rolled_back; put "$n" rollback_at "$t"; put "$n" next $((t+ROLLBACK_GRACE_S)); return 1
 fi
 log "service=$n action=tier0_rollback_failed reason=no_usable_lkg"; human_escalate "$n"; return 1
}
fail(){ n="$1"; put "$n" stable_since 0; c=$(( $(get "$n" failures 0)+1 )); [ "$c" -gt 6 ] && c=6; delay=$((15*(1<<(c-1)))); [ "$delay" -gt 900 ] && delay=900; put "$n" failures "$c"; put "$n" status degraded; put "$n" next $(( $(now)+delay )); log "service=$n state=degraded failures=$c retry_in_s=$delay"; if [ "$c" -eq 3 ]; then probe_correlation="probe-$(now)-$$-$n"; opened=$(incident_open "$n" "$probe_correlation"); IFS='|' read -r iid correlation_id <<EOF
$opened
EOF
 log "service=$n action=incident_opened incident_id=$iid correlation_id=$correlation_id"; if "$ROOT/incident-orchestrator.py" handled "$n" 9>&- >/dev/null 2>&1; then "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source health-manager --reason "deterministic recovery exhausted; managed handler available" >/dev/null 2>&1 || true; shadow "$n" "$c" "$iid"; else "$ROOT/incident-orchestrator.py" transition "$iid" awaiting_deterministic_recovery --source health-manager --reason "no managed handler; waiting for health-manager verification" >/dev/null 2>&1 || true; log "service=$n state=awaiting_deterministic_recovery reason=no_repair_handler incident_id=$iid correlation_id=$correlation_id"; fi; fi; }
due(){ [ "$(now)" -ge "$(get "$1" next 0)" ]; }
start(){ nohup "$2" 9>&- >>"$D/$1.stderr.log" 2>&1 </dev/null & }
process_uses_script(){
  pat="$1"; script="$2"
  for pid in $(pgrep -f "$pat" 9>&- 2>/dev/null); do
    [ -r "/proc/$pid/cmdline" ] || continue
    while IFS= read -r -d '' arg; do
      [ "$arg" = "$script" ] && return 0
    done <"/proc/$pid/cmdline" 2>/dev/null
  done
  return 1
}
supervisor_on_current_root(){ process_uses_script "$1" "$2"; }
stop_supervisor(){ pat="$1"; pkill -TERM -f "$pat" 9>&- 2>/dev/null || true; waited=0; while proc "$pat" && [ "$waited" -lt 8 ]; do sleep 1 9>&-; waited=$((waited+1)); done; if proc "$pat"; then log "service=supervisor state=stop_timeout pattern=$pat action=kill_stale"; pkill -KILL -f "$pat" 9>&- 2>/dev/null || true; sleep 1 9>&-; fi; }
supervisor_lock(){ case "$1" in adb_watchdog) printf '%s' "$HOME/.openclaw/watchdogs/adb-recovery.lock";; remote_watchdog) printf '%s' "$HOME/.openclaw/watchdogs/remote-desktop.lock";; incident_manager) printf '%s' "$HOME/.openclaw/incidents/manager.lock";; *) return 1;; esac; }
wait_supervisor_lock(){
 n="$1"; lock=$(supervisor_lock "$n") || return 0; waited=0
 while :; do
   exec 8>"$lock"
   if flock -n 8 9>&- 2>/dev/null; then flock -u 8 9>&- 2>/dev/null || true; exec 8>&-; return 0; fi
   exec 8>&-
   waited=$((waited+1))
   [ "$waited" -ge 20 ] && { log "service=$n state=lock_timeout lock=$lock"; return 1; }
   printf '%s' "$(now)" >"$D/health-manager.heartbeat"
   sleep 1 9>&-
 done
}
check_supervisor(){ n="$1"; pat="$2"; script="$3"; if proc "$pat" && supervisor_on_current_root "$pat" "$script"; then healthy "$n"; return; fi; unstable "$n"; due "$n" || return; restart_gate "$n" || return; if proc "$pat"; then log "service=$n state=stale_runtime action=replace expected=$script"; stop_supervisor "$pat"; wait_supervisor_lock "$n" || { fail "$n"; return; }; else log "service=$n action=start"; fi; start "$n" "$script"; sleep 3 9>&-; proc "$pat" && supervisor_on_current_root "$pat" "$script" && healthy "$n" || fail "$n"; }
# A Companion deploy stops and restarts the server itself: never "repair" it meanwhile (S24 11/10: EADDRINUSE,
# 15 concurrent repairs a day, each one cutting the Remote Bridge). The canonical mode also closes the race
# between the outer loop and this repair boundary.
check_http(){ n="$1"; url="$2"; pat="$3"; script="$4"; grace="${5:-10}"; stop_wait="${6:-20}"; if http "$url"; then healthy "$n"; return; fi; unstable "$n"; repair_mode=$(canonical_mode); if [ "$repair_mode" != normal ]; then [ "$repair_mode" = deployment ] && repair_mode=deploy_in_progress; log "service=$n state=${repair_mode:-canonical_mode_unknown} action=skip_repair"; return; fi; due "$n" || return; if proc "$pat"; then log "service=$n state=starting_or_unhealthy grace_s=$grace"; sleep "$grace" 9>&-; if http "$url"; then healthy "$n"; return; fi; fi; if [ "$n" = companion ] && ! companion_idle_proven; then log "service=$n state=idle_unproven action=skip_repair"; put "$n" next $(( $(now)+15 )); return; fi; restart_gate "$n" || return; log "service=$n action=repair"; if proc "$pat"; then pkill -TERM -f "$pat" 9>&- 2>/dev/null || true; waited=0; while proc "$pat" && [ "$waited" -lt "$stop_wait" ]; do sleep 2 9>&-; waited=$((waited+2)); done; if proc "$pat"; then log "service=$n state=stop_timeout waited_s=$waited action=kill_stale"; pkill -KILL -f "$pat" 9>&- 2>/dev/null || true; sleep 2 9>&-; if proc "$pat"; then fail "$n"; return; fi; fi; fi; start "$n" "$script"; sleep "$grace" 9>&-; http "$url" && healthy "$n" || fail "$n"; }
check_adb(){ if adb_ok; then prev=$(get adb status unknown); healthy adb; [ "$prev" = healthy ] || { "$ROOT/capability-recovered.py" device.adb 9>&- >/dev/null 2>&1 || true; "$ROOT/chat-continuity-restore.sh" 9>&- >/dev/null 2>&1 || true; }; return; fi; unstable adb; due adb || return; restart_gate adb || return; log 'service=adb action=fast_reconnect'; timeout 4 adb 9>&- connect 127.0.0.1:5556 >/dev/null 2>&1||true; sleep 1 9>&-; adb_ok && healthy adb || fail adb; }
verdict_field(){ python3 - "$D/current.json" "$1" "$2" <<'PY'
import json,sys
try:
 row=json.load(open(sys.argv[1])).get('capabilities',{}).get(sys.argv[2],{})
 print(row.get(sys.argv[3]) or '')
except Exception: print('')
PY
}
check_gateway(){ if http http://127.0.0.1:18789/healthz; then put gateway first_down 0; healthy gateway; return; fi; due gateway || return; first=$(get gateway first_down 0); if [ "$first" -le 0 ]; then first=$(now); put gateway first_down "$first"; put gateway next $((first+30)); log 'service=gateway state=unhealthy owner=companion grace_s=180'; return; fi; age=$(( $(now)-first )); if [ "$age" -lt 180 ]; then put gateway next $(( $(now)+30 )); return; fi; fail gateway; }
check_whatsapp(){
 st=$(verdict_field notification.whatsapp state); reason=$(verdict_field notification.whatsapp reason); prev=$(get whatsapp status unknown)
 if [ "$st" = healthy ]; then
  if [ "$prev" = human_required ]; then "$ROOT/incident-orchestrator.py" recover whatsapp runtime --source health-manager --reason "WhatsApp channel verified connected after relink" >/dev/null 2>&1 || true; "$ROOT/incident-close.sh" WhatsApp "Samantha — WhatsApp est de nouveau connecté et vérifié." || true; fi
  put whatsapp unready_since 0; put whatsapp terminal_notified 0; healthy whatsapp; return
 fi
 # WhatsApp is an external readiness dependency, not process liveness. A
 # transient channel flap is observed as degraded and cannot trigger a repair
 # or incident. Only a continuous 120 s outage may enter the existing
 # deterministic lock recovery / incident path. A healthy observation above
 # resets the window, so separate flaps never accumulate.
 tick=$(now); since=$(get whatsapp unready_since 0)
 case "$since" in ''|*[!0-9]*|0) since="$tick"; put whatsapp unready_since "$since";; esac
 if [ "$tick" -lt "$since" ]; then since="$tick"; put whatsapp unready_since "$since"; fi
 unavailable_for=$((tick-since))
 if [ "$unavailable_for" -lt "$WHATSAPP_READINESS_GRACE_S" ]; then
  [ "$prev" = degraded ] || log "service=whatsapp state=degraded probe=readiness reason=${reason:-unknown} incident=deferred grace_s=$WHATSAPP_READINESS_GRACE_S"
  put whatsapp status degraded; put whatsapp failures 0; put whatsapp next $((tick+15)); return
 fi
 if [ "$reason" = terminal_auth_logout ]; then
  if [ "$(get whatsapp terminal_notified 0)" != 1 ]; then probe_correlation="probe-$(now)-$$-whatsapp"; opened=$(incident_open whatsapp "$probe_correlation" "WhatsApp terminal authentication logout (401 conflict)"); IFS='|' read -r iid correlation_id <<EOF
$opened
EOF
   "$ROOT/incident-orchestrator.py" transition "$iid" human_required --source health-manager --reason "WhatsApp session logged out; QR relink required" --human-boundary >/dev/null 2>&1 || true; "$ROOT/incident-notify.sh" human_required "Samantha — WhatsApp est déconnecté (401 conflict / session logged out)." "Relier WhatsApp avec openclaw channels login --channel whatsapp puis scanner le QR." || true; put whatsapp terminal_notified 1; log "service=whatsapp state=human_required incident_id=$iid correlation_id=$correlation_id reason=terminal_auth_logout"; fi
  put whatsapp status human_required; put whatsapp next 0; return
 fi
 due whatsapp || return
 if [ "$reason" = channel_not_connected ]; then
  unstable whatsapp
  lock_out=$("$ROOT/whatsapp-lock-recovery.py" --grace-seconds 120 2>&1); lock_rc=$?
  if [ "$lock_rc" -eq 10 ]; then
   restart_gate whatsapp || return
   log "service=whatsapp state=stale_lock_quarantined action=gateway_restart detail=$lock_out"
   put whatsapp status recovering; put whatsapp failures 0; put whatsapp next $(( $(now)+45 ))
   nohup timeout --kill-after=5 240 curl -fsS --max-time 230 \
     -X POST -H 'Content-Type: application/json' -d '{}' \
     http://127.0.0.1:8765/v1/runtime/restart 9>&- \
     >>"$D/whatsapp-recovery.log" 2>&1 </dev/null &
   log "service=whatsapp state=recovery_restart_requested owner=companion pid=$!"
   return
  fi
  if [ "$lock_rc" -eq 30 ]; then log "service=whatsapp state=lock_recovery_refused detail=$lock_out"; fail whatsapp; return; fi
 fi
 fail whatsapp
}
# P0-4: Gateway memory guard (measured thresholds, sustained 10 min, idle proof, 6 h cooldown,
# receipt health/gateway-memory-guard.json). Graceful restart through the existing Companion route.
check_gateway_memory(){
 due gateway_memory || return
 put gateway_memory next $(( $(now)+60 ))
 out=$(timeout 15 python3 "$ROOT/gateway-memory-guard.py" 9>&- 2>/dev/null) || { log "service=gateway_memory state=guard_failed"; return; }
 case "$out" in
  *'"action": "restart_requested"'*)
   restart_gate gateway_memory || return
   log "service=gateway_memory state=restart_requested owner=companion detail=$out"
   ( timeout --kill-after=5 240 curl -fsS --max-time 230 \
       -X POST -H 'Content-Type: application/json' -d '{}' \
       http://127.0.0.1:8765/v1/runtime/restart 2>&1 \
     | python3 "$ROOT/bounded-log.py" "$D/gateway-memory-restart.log" --stream ) 9>&- </dev/null >/dev/null 2>&1 &
   ;;
  *'"pressure": ["'*) log "service=gateway_memory state=pressure detail=$out";;
 esac
}
check_smtp(){ due smtp || return; if timeout 25 "$ROOT/incident-email.sh" --probe 9>&- >/dev/null 2>&1; then healthy smtp; put smtp next $(( $(now)+300 )); else fail smtp; fi; }
# Le check restaure tout bail réseau dont le garde est mort ou dont le TTL est échu (ligne de reçu
# écrite par le garde dans ce journal). Wi-Fi coupé SANS bail : jamais réactivé automatiquement
# (choix possible d'Amine), seulement signalé ici une fois par transition et dans le reçu santé.
check_network_safety(){ due network_safety || return; if "$ROOT/android-network-mutation-guard.py" check 9>&- >/dev/null 2>&1; then healthy network_safety; else fail network_safety; fi; network_wifi_warning; }
network_wifi_warning(){
 w=$(python3 - "$D/network-mutation-safety.json" 9>&- 2>/dev/null <<'PY'
import json,sys
try: print('1' if 'wifi_disabled_without_lease' in (json.load(open(sys.argv[1])).get('warnings') or []) else '0')
except Exception: print('0')
PY
)
 [ "$w" = "$(get network_wifi_unmanaged status 0)" ] && return 0
 put network_wifi_unmanaged status "$w"
 if [ "$w" = 1 ]; then log 'service=network_safety state=warning reason=wifi_disabled_without_lease action=none'; else log 'service=network_safety state=warning_cleared reason=wifi_disabled_without_lease'; fi
}
check_android_phantom_headroom(){
 due android_phantom_headroom || return
 if ! adb_ok; then put android_phantom_headroom next $(( $(now)+PHANTOM_HEADROOM_CHECK_S )); return; fi
 effective=$(exec 9>&-; timeout 4 adb -s 127.0.0.1:5556 shell dumpsys activity settings 2>/dev/null | sed -n 's/.*max_phantom_processes=\([0-9][0-9]*\).*/\1/p' | head -n 1)
 case "$effective" in ''|*[!0-9]*) log "service=android_phantom_headroom state=probe_failed"; fail android_phantom_headroom; return;; esac
 if [ "$effective" -ge "$PHANTOM_HEADROOM_TARGET" ]; then healthy android_phantom_headroom; put android_phantom_headroom next $(( $(now)+PHANTOM_HEADROOM_CHECK_S )); return; fi
 override=$(exec 9>&-; timeout 3 adb -s 127.0.0.1:5556 shell device_config get activity_manager max_phantom_processes 2>/dev/null | tr -d '\r\n')
 log "service=android_phantom_headroom state=drift override=${override:-unknown} effective=$effective target=$PHANTOM_HEADROOM_TARGET action=restore"
 if timeout 5 adb 9>&- -s 127.0.0.1:5556 shell device_config put activity_manager max_phantom_processes "$PHANTOM_HEADROOM_TARGET" >/dev/null 2>&1; then
   verified=$(exec 9>&-; timeout 4 adb -s 127.0.0.1:5556 shell dumpsys activity settings 2>/dev/null | sed -n 's/.*max_phantom_processes=\([0-9][0-9]*\).*/\1/p' | head -n 1)
   case "$verified" in ''|*[!0-9]*) verified=0;; esac
   if [ "$verified" -ge "$PHANTOM_HEADROOM_TARGET" ]; then
     healthy android_phantom_headroom
     put android_phantom_headroom next $(( $(now)+PHANTOM_HEADROOM_CHECK_S ))
     log "service=android_phantom_headroom state=recovered effective=$verified target=$PHANTOM_HEADROOM_TARGET"
     return
   fi
 fi
 fail android_phantom_headroom
}
ssh_ok(){ timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/8022' 9>&- >/dev/null 2>&1; }
check_sshd(){
 if ssh_ok; then healthy sshd; return; fi
 unstable sshd
 due sshd || return
 restart_gate sshd || return
 log 'service=sshd action=start port=8022'
 /data/data/com.termux/files/usr/bin/sshd 9>&- >>"$D/sshd.stderr.log" 2>&1 || true
 sleep 1 9>&-
 ssh_ok && healthy sshd || fail sshd
}
slack_bridge_on_current_root(){ process_uses_script '[c]law-slack-bridge.mjs' "$ROOT/claw-slack-bridge.mjs"; }
stop_slack_bridge(){ pkill -TERM -f '[c]law-slack-bridge.mjs' 2>/dev/null || true; waited=0; while proc '[c]law-slack-bridge.mjs' && [ "$waited" -lt 8 ]; do sleep 1 9>&-; waited=$((waited+1)); done; if proc '[c]law-slack-bridge.mjs'; then log "service=slack_bridge state=stop_timeout waited_s=$waited action=kill_stale"; pkill -KILL -f '[c]law-slack-bridge.mjs' 2>/dev/null || true; sleep 1 9>&-; fi; }
check_slack_bridge(){
 "$ROOT/claw-slack-bridge-health.py" 9>&- >/dev/null 2>&1; rc=$?
 if [ "$rc" -eq 2 ]; then
   proc '[c]law-slack-bridge.mjs' && stop_slack_bridge
   put slack_bridge status setup_required; put slack_bridge failures 0; put slack_bridge next 0
   return
 fi
 if [ "$rc" -eq 0 ] && slack_bridge_on_current_root; then healthy slack_bridge; return; fi
 if [ "$rc" -eq 3 ] && slack_bridge_on_current_root; then
   put slack_bridge status delivery_attention; put slack_bridge next 0
   return
 fi
 unstable slack_bridge
 due slack_bridge || return
 restart_gate slack_bridge || return
 if proc '[c]law-slack-bridge.mjs'; then
   if slack_bridge_on_current_root; then
     log 'service=slack_bridge state=degraded action=restart'
   else
     log "service=slack_bridge state=stale_runtime action=replace expected_root=$ROOT"
   fi
   stop_slack_bridge
 else
   log 'service=slack_bridge action=start'
 fi
 start slack_bridge "$ROOT/claw-slack-bridge.sh"
 sleep 3 9>&-
 if "$ROOT/claw-slack-bridge-health.py" 9>&- >/dev/null 2>&1 && slack_bridge_on_current_root; then healthy slack_bridge; else fail slack_bridge; fi
}
# R17 runs cooperatively inside this owner, never in an extra daemon.
# last_sweep extends the existing per-service health state (same sf/get/put).
ALLOWLIST_LAST_CHECK=$(get whatsapp_allowlist last_sweep 0)
# 12/10 « zéro désynchronisation » : every 30 min, prove each runtime copy and rule still matches the deployed commit.
check_runtime_drift(){ [ "$(now)" -ge "$(get runtime_drift next 0)" ] || return; put runtime_drift next $(( $(now)+1800 )); [ "$(canonical_mode)" = normal ] || return; out=$(timeout 90 "$ROOT/runtime-sync.sh" --check 9>&- 2>/dev/null); rc=$?; if [ "$rc" -eq 0 ]; then [ "$(get runtime_drift status aligned)" = aligned ] || log "service=runtime_drift state=aligned"; put runtime_drift status aligned; put runtime_drift sig none; return; fi; detail=$(printf '%s' "$out" | tr -d '\n' | cut -c1-300); sig=$(printf '%s' "$detail" | sha256sum | cut -c1-16); put runtime_drift status drift; log "service=runtime_drift state=drift rc=$rc detail=$detail"; [ "$(get runtime_drift sig none)" = "$sig" ] && return; put runtime_drift sig "$sig"; "$ROOT/incident-notify.sh" human_required "Samantha — une copie du runtime n'est plus alignée sur le commit déployé : $detail" "Relancer companion-deploy.sh sur le commit déployé (runtime-sync.sh remet chaque copie au même commit)." || true; }
check_allowlist_expiry(){
 local tick elapsed result processed forgotten remaining
 tick=$(now);elapsed=$((tick-ALLOWLIST_LAST_CHECK))
 [ "$elapsed" -ge 60 ] || [ "$elapsed" -lt 0 ] || return 0
 ALLOWLIST_LAST_CHECK="$tick"
 result=$(timeout --kill-after=2 22 python3 "$ROOT/people-trusted.py" allowlist sweep 9>&- <<<'{}' 2>/dev/null) || { log 'service=whatsapp_allowlist state=expired_pending reason=sweep_budget'; return 0; }
 read -r processed forgotten remaining <<<"$(printf '%s' "$result" | python3 -c 'import json,sys; v=json.load(sys.stdin); f=v.get("forget") or {}; print(v.get("processed",0),f.get("forgotten",0),f.get("remaining",0))' 9>&- 2>/dev/null)" || return 0
 case "$processed" in ''|*[!0-9]*) return 0;; esac
 # M4 forget-on-expiry: counts only, never a number, name or message.
 case "$forgotten$remaining" in ''|*[!0-9]*) ;; *) [ "$forgotten" -gt 0 ] && log "service=whatsapp_allowlist event=forget forgotten=$forgotten remaining=$remaining";; esac
 # No R17 disk write when no expiry was processed.
 [ "$processed" -gt 0 ] && put whatsapp_allowlist last_sweep "$tick"
 return 0
}
log 'event=start result=ok state=persistent_backoff'
while :; do
 printf '%s' "$(date +%s)" >"$D/health-manager.heartbeat"
 mode=$(canonical_mode); [ -n "$mode" ] || mode=unknown
 previous_mode=$(get canonical_mode status unknown)
 if [ "$mode" != "$previous_mode" ]; then log "service=canonical_mode state=$mode"; put canonical_mode status "$mode"; fi
 if [ "$mode" != normal ]; then
  "$ROOT/health-verdict.py" --write 9>&- >/dev/null 2>&1 || true
  sleep 15 9>&-
  continue
 fi
 check_allowlist_expiry
 check_supervisor root_guardian '[s]amantha-root-guardian.sh' "$ROOT/samantha-root-guardian.sh"
 check_allowlist_expiry
 check_supervisor adb_watchdog '[a]db-recovery-watchdog.sh' "$ROOT/adb-recovery-watchdog.sh"
 check_allowlist_expiry
 check_supervisor remote_watchdog '[r]emote-desktop-watchdog.sh' "$ROOT/remote-desktop-watchdog.sh"
 check_allowlist_expiry
 check_supervisor incident_manager '[i]ncident-manager.sh' "$ROOT/incident-manager.sh"
 check_allowlist_expiry
 "$ROOT/incident-ingress.py" 9>&- >/dev/null 2>&1 || true
 check_allowlist_expiry
 "$ROOT/incident-reconcile.sh" 9>&- >/dev/null 2>&1 || true
 check_allowlist_expiry
 check_adb
 check_allowlist_expiry
 check_android_phantom_headroom
 check_allowlist_expiry
 check_network_safety
 check_allowlist_expiry
 check_sshd
 printf '%s' "$(date +%s)" >"$D/health-manager.heartbeat"
 check_allowlist_expiry
 "$ROOT/health-verdict.py" --write 9>&- >/dev/null 2>&1 || true
 check_allowlist_expiry
 # F7: existing maintenance cycle; Companion-owned O_APPEND log stays on its inode.
 timeout --kill-after=1 2 python3 "$ROOT/gateway-log-retention.py" 9>&- >/dev/null 2>&1 || true
 check_gateway
 check_allowlist_expiry
 check_gateway_memory
 check_allowlist_expiry
 check_whatsapp
 check_allowlist_expiry
 check_smtp
 check_allowlist_expiry
 check_http companion http://127.0.0.1:8765/ 'dist/companion/[s]erver.js' "$ROOT/companion-server.sh" 12 20
 check_allowlist_expiry
 check_slack_bridge
 check_runtime_drift
 sleep 15 9>&-
done
