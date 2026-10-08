#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"; D="$HOME/.openclaw/health"; LOG="$D/health.log"; S="$D/state"; mkdir -p "$D" "$S"; export TMPDIR="$HOME/.cache/tmp"
PHANTOM_HEADROOM_TARGET=128; PHANTOM_HEADROOM_CHECK_S=60
exec 9>"$D/health.lock"; flock -n 9 || exit 0
log(){ printf '%s component=health-manager %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
proc(){ pgrep -f "$1" 9>&- >/dev/null 2>&1; }; http(){ timeout 3 curl -fsS "$1" 9>&- >/dev/null 2>&1; }; adb_ok(){ timeout 3 adb 9>&- -s 127.0.0.1:5556 get-state 2>/dev/null|grep -qx device 9>&-; }
now(){ date +%s; }; sf(){ echo "$S/$1.$2"; }; get(){ cat "$(sf "$1" "$2")" 2>/dev/null || echo "${3:-0}"; }; put(){ printf '%s' "$3" >"$(sf "$1" "$2")"; }
healthy(){ n="$1"; prev=$(get "$n" status unknown); old=$(get "$n" failures 0); [ "$prev" = healthy ] || log "service=$n state=healthy"; put "$n" status healthy; put "$n" failures 0; put "$n" next 0; if [ "$prev" = degraded ] && [ "$old" -ge 3 ]; then "$ROOT/incident-orchestrator.py" recover "$n" "$(scope "$n")" --source health-manager --reason "service health verified after recovery" >/dev/null 2>&1 || true; "$ROOT/incident-close.sh" "$n" "Samantha — $n est de nouveau opérationnel et la récupération est vérifiée." || true; fi; }
scope(){ if [ "$1" = adb ]; then printf "boot-%s" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"; else printf runtime; fi; }
incident_open(){ "$ROOT/incident-orchestrator.py" open "$1" "$(scope "$1")" --source health-manager --summary "$1 persistent health failure" 2>/dev/null | python -c 'import sys,json; print(json.load(sys.stdin)["id"])'; }
shadow(){ n="$1"; c="$2"; iid="$3"; nohup "$ROOT/autonomous-engineering-shadow.sh" "$n" "$c" "$iid" 9>&- >>"$D/autonomous-engineering-shadow.stderr.log" 2>&1 </dev/null & }
fail(){ n="$1"; c=$(( $(get "$n" failures 0)+1 )); [ "$c" -gt 6 ] && c=6; delay=$((15*(1<<(c-1)))); [ "$delay" -gt 900 ] && delay=900; put "$n" failures "$c"; put "$n" status degraded; put "$n" next $(( $(now)+delay )); log "service=$n state=degraded failures=$c retry_in_s=$delay"; if [ "$c" -eq 3 ]; then iid=$(incident_open "$n"); log "service=$n action=autonomous_engineering_shadow incident_id=$iid"; "$ROOT/incident-orchestrator.py" transition "$iid" diagnosing --source health-manager --reason "deterministic recovery exhausted" >/dev/null 2>&1 || true; shadow "$n" "$c" "$iid"; fi; }
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
check_supervisor(){ n="$1"; pat="$2"; script="$3"; if proc "$pat" && supervisor_on_current_root "$pat" "$script"; then healthy "$n"; return; fi; due "$n" || return; if proc "$pat"; then log "service=$n state=stale_runtime action=replace expected=$script"; stop_supervisor "$pat"; wait_supervisor_lock "$n" || { fail "$n"; return; }; else log "service=$n action=start"; fi; start "$n" "$script"; sleep 3 9>&-; proc "$pat" && supervisor_on_current_root "$pat" "$script" && healthy "$n" || fail "$n"; }
check_http(){ n="$1"; url="$2"; pat="$3"; script="$4"; grace="${5:-10}"; stop_wait="${6:-20}"; if http "$url"; then healthy "$n"; return; fi; due "$n" || return; if proc "$pat"; then log "service=$n state=starting_or_unhealthy grace_s=$grace"; sleep "$grace" 9>&-; if http "$url"; then healthy "$n"; return; fi; fi; log "service=$n action=repair"; if proc "$pat"; then pkill -TERM -f "$pat" 9>&- 2>/dev/null || true; waited=0; while proc "$pat" && [ "$waited" -lt "$stop_wait" ]; do sleep 2 9>&-; waited=$((waited+2)); done; if proc "$pat"; then log "service=$n state=stop_timeout waited_s=$waited action=kill_stale"; pkill -KILL -f "$pat" 9>&- 2>/dev/null || true; sleep 2 9>&-; if proc "$pat"; then fail "$n"; return; fi; fi; fi; start "$n" "$script"; sleep "$grace" 9>&-; http "$url" && healthy "$n" || fail "$n"; }
check_adb(){ if adb_ok; then prev=$(get adb status unknown); healthy adb; [ "$prev" = healthy ] || { "$ROOT/capability-recovered.py" device.adb 9>&- >/dev/null 2>&1 || true; "$ROOT/chat-continuity-restore.sh" 9>&- >/dev/null 2>&1 || true; }; return; fi; due adb || return; log 'service=adb action=fast_reconnect'; timeout 4 adb 9>&- connect 127.0.0.1:5556 >/dev/null 2>&1||true; sleep 1 9>&-; adb_ok && healthy adb || fail adb; }
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
  put whatsapp terminal_notified 0; healthy whatsapp; return
 fi
 if [ "$reason" = terminal_auth_logout ]; then
  if [ "$(get whatsapp terminal_notified 0)" != 1 ]; then iid=$("$ROOT/incident-orchestrator.py" open whatsapp runtime --source health-manager --summary "WhatsApp terminal authentication logout (401 conflict)" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'); "$ROOT/incident-orchestrator.py" transition "$iid" human_required --source health-manager --reason "WhatsApp session logged out; QR relink required" --human-boundary >/dev/null 2>&1 || true; "$ROOT/incident-notify.sh" human_required "Samantha — WhatsApp est déconnecté (401 conflict / session logged out)." "Relier WhatsApp avec openclaw channels login --channel whatsapp puis scanner le QR." || true; put whatsapp terminal_notified 1; log "service=whatsapp state=human_required incident_id=$iid reason=terminal_auth_logout"; fi
  put whatsapp status human_required; put whatsapp next 0; return
 fi
 due whatsapp || return
 if [ "$reason" = channel_not_connected ]; then
  lock_out=$("$ROOT/whatsapp-lock-recovery.py" --grace-seconds 120 2>&1); lock_rc=$?
  if [ "$lock_rc" -eq 10 ]; then
   log "service=whatsapp state=stale_lock_quarantined action=gateway_restart detail=$lock_out"
   put whatsapp status recovering; put whatsapp failures 0; put whatsapp next $(( $(now)+45 ))
   timeout 30 openclaw gateway restart 9>&- >>"$D/whatsapp-recovery.log" 2>&1 || log 'service=whatsapp state=recovery_restart_failed'
   return
  fi
  if [ "$lock_rc" -eq 30 ]; then log "service=whatsapp state=lock_recovery_refused detail=$lock_out"; fail whatsapp; return; fi
 fi
 fail whatsapp
}
check_smtp(){ due smtp || return; if timeout 25 "$ROOT/incident-email.sh" --probe 9>&- >/dev/null 2>&1; then healthy smtp; put smtp next $(( $(now)+300 )); else fail smtp; fi; }
check_network_safety(){ due network_safety || return; if "$ROOT/android-network-mutation-guard.py" check 9>&- >/dev/null 2>&1; then healthy network_safety; else fail network_safety; fi; }
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
 due sshd || return
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
 due slack_bridge || return
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
log 'event=start result=ok state=persistent_backoff'
while :; do
 printf '%s' "$(date +%s)" >"$D/health-manager.heartbeat"
 check_supervisor root_guardian '[s]amantha-root-guardian.sh' "$ROOT/samantha-root-guardian.sh"
 check_supervisor adb_watchdog '[a]db-recovery-watchdog.sh' "$ROOT/adb-recovery-watchdog.sh"
 check_supervisor remote_watchdog '[r]emote-desktop-watchdog.sh' "$ROOT/remote-desktop-watchdog.sh"
 check_supervisor incident_manager '[i]ncident-manager.sh' "$ROOT/incident-manager.sh"
 "$ROOT/incident-ingress.py" 9>&- >/dev/null 2>&1 || true
 "$ROOT/incident-reconcile.sh" 9>&- >/dev/null 2>&1 || true
 check_adb
 check_android_phantom_headroom
 check_network_safety
 check_sshd
 printf '%s' "$(date +%s)" >"$D/health-manager.heartbeat"
 "$ROOT/health-verdict.py" --write 9>&- >/dev/null 2>&1 || true
 check_gateway
 check_whatsapp
 check_smtp
 check_http companion http://127.0.0.1:8765/ 'dist/companion/[s]erver.js' "$ROOT/companion-server.sh" 12 20
 check_slack_bridge
 sleep 15 9>&-
done
