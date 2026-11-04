#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"; D="$HOME/.openclaw/health"; LOG="$D/health.log"; S="$D/state"; mkdir -p "$D" "$S"; export TMPDIR="$HOME/.cache/tmp"
PHANTOM_HEADROOM_TARGET=128; PHANTOM_HEADROOM_CHECK_S=60
RESTART_BUDGET_N="${HEALTH_RESTART_BUDGET_N:-3}"
RESTART_WINDOW_S="${HEALTH_RESTART_WINDOW_S:-3600}"
STABILITY_RESET_S="${HEALTH_STABILITY_RESET_S:-600}"
ROLLBACK_GRACE_S="${HEALTH_ROLLBACK_GRACE_S:-120}"
LATCHED_RETRY_S="${HEALTH_LATCHED_RETRY_S:-900}"
case "$RESTART_BUDGET_N:$RESTART_WINDOW_S:$STABILITY_RESET_S:$ROLLBACK_GRACE_S:$LATCHED_RETRY_S" in *[!0-9:]*) exit 64;; esac
[ "$RESTART_BUDGET_N" -ge 1 ] && [ "$RESTART_WINDOW_S" -ge 1 ] && [ "$STABILITY_RESET_S" -ge 1 ] && [ "$ROLLBACK_GRACE_S" -ge 1 ] || exit 64
WHATSAPP_READINESS_GRACE_S=120
if [ -f "$ROOT/immune-action.sh" ]; then . "$ROOT/immune-action.sh"; else
 immune_action(){ return 75; }; immune_observe(){ :; }
fi
exec 9>"$D/health.lock"; flock -n 9 || exit 0
log(){ python3 "$ROOT/bounded-log.py" "$LOG" --append "$(date -Iseconds) component=health-manager $*"; }
proc(){ pgrep -f "$1" 9>&- >/dev/null 2>&1; }; http(){ timeout 3 curl -fsS "$1" 9>&- >/dev/null 2>&1; }; adb_ok(){ timeout 3 adb 9>&- -s 127.0.0.1:5556 get-state 2>/dev/null|grep -qx device 9>&-; }
now(){ date +%s; }; sf(){ echo "$S/$1.$2"; }; get(){ cat "$(sf "$1" "$2")" 2>/dev/null || echo "${3:-0}"; }; put(){ printf '%s' "$3" >"$(sf "$1" "$2")"; }
canonical_mode(){ python3 "$ROOT/runtime_mode.py" 9>&- 2>/dev/null || true; }
companion_idle_proven(){ timeout 8 python3 "$ROOT/gateway-memory-guard.py" --idle-proof 9>&- >/dev/null 2>&1; }
unstable(){ put "$1" stable_since 0; }
reset_restart_budget(){
 n="$1"; rm -f "$(sf "$n" restart_attempts)" "$(sf "$n" escalation)" "$(sf "$n" rollback_at)" "$(sf "$n" latched_retry_at)"
 put "$n" failures 0; put "$n" next 0
}
healthy(){
 immune_observe "$1" --healthy
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
 n="$1"; why="${2:-rollback}"; probe_correlation="probe-$(now)-$$-$n"; opened=$(incident_open "$n" "$probe_correlation") || return 1; IFS='|' read -r iid correlation_id <<EOF
$opened
EOF
 if [ "$why" = device_scope ]; then
  reason="Tier0 rollback cannot repair device-scoped $n; hourly restart budget exhausted"; code=restart_budget_exhausted_device_scope
  text="Samantha — $n reste indisponible après le budget de relances ; un retour arrière Tier0 ne peut pas le réparer (incident $iid)."
  action="Sur le S24 : vérifier le Wi-Fi puis Options développeur > Débogage sans fil. Aucune nouvelle relance automatique avant 10 minutes de stabilité vérifiée."
 else
  reason="Tier0 rollback did not restore $n after the hourly restart budget"; code=restart_budget_and_rollback_exhausted
  text="Samantha — $n reste indisponible après le budget de relances et le retour arrière Tier0 (incident $iid)."
  action="Vérifier le composant $n et l'incident $iid ; aucune nouvelle relance automatique ne sera tentée avant 10 minutes de stabilité vérifiée."
 fi
 "$ROOT/incident-orchestrator.py" transition "$iid" human_required --source health-manager --reason "$reason" --human-boundary >/dev/null 2>&1 || true
 "$ROOT/incident-notify.sh" human_required "$text" "$action" || true
 put "$n" escalation human_required; put "$n" status human_required; log "service=$n state=human_required incident_id=$iid correlation_id=$correlation_id reason=$code"
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
 rm -f "$tmp"
 # Un service de l'appareil (scope boot-*, aujourd'hui l'ADB) ne dépend pas de la release : un retour arrière Tier0
 # ne le répare pas et redémarre gateway et companion pour rien (S24 18/10 16:27 : Wi-Fi coupé, ADB sans fil perdu,
 # rollback pendant « mon solde Orange » → service_unavailable). Escalade humaine directe, sans rollback.
 case "$(scope "$n")" in runtime) ;; *) log "service=$n action=tier0_rollback_skipped reason=device_scope budget=$count/$RESTART_BUDGET_N"; human_escalate "$n" device_scope; return 1;; esac
 log "service=$n action=tier0_rollback reason=restart_budget_exhausted budget=$count/$RESTART_BUDGET_N"
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
start(){ nohup "${@:2}" 9>&- >>"$D/$1.stderr.log" 2>&1 </dev/null & }
# Extra arguments after the script (e.g. --gateway-only) are part of the supervisor's identity: a process
# running the same script without them is another mode and is replaced like a stale release.
process_uses_script(){
  pat="$1"; script="$2"; shift 2
  local found want missing argv
  for pid in $(pgrep -f "$pat" 9>&- 2>/dev/null); do
    [ -r "/proc/$pid/cmdline" ] || continue
    found=; argv=$'\n'
    while IFS= read -r -d '' arg; do
      [ "$arg" = "$script" ] && found=1
      argv+="$arg"$'\n'
    done <"/proc/$pid/cmdline" 2>/dev/null
    [ -n "$found" ] || continue
    missing=; for want in "$@"; do [[ "$argv" == *$'\n'"$want"$'\n'* ]] || missing=1; done
    [ -z "$missing" ] && return 0
  done
  return 1
}
supervisor_on_current_root(){ process_uses_script "$@"; }
stop_supervisor(){ pat="$1"; pkill -TERM -f "$pat" 9>&- 2>/dev/null || true; waited=0; while proc "$pat" && [ "$waited" -lt 8 ]; do sleep 1 9>&-; waited=$((waited+1)); done; if proc "$pat"; then log "service=supervisor state=stop_timeout pattern=$pat action=kill_stale"; pkill -KILL -f "$pat" 9>&- 2>/dev/null || true; sleep 1 9>&-; fi; }
supervisor_lock(){ case "$1" in adb_watchdog) printf '%s' "$HOME/.openclaw/watchdogs/adb-recovery.lock";; remote_watchdog) printf '%s' "$HOME/.openclaw/watchdogs/remote-desktop.lock";; core_services_watchdog) printf '%s' "$HOME/.openclaw/watchdogs/core-services.lock";; incident_manager) printf '%s' "$HOME/.openclaw/incidents/manager.lock";; *) return 1;; esac; }
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
# Un superviseur VIVANT sur une release précédente n'est pas en panne : un déploiement a changé la release.
# Le réaligner ne consomme pas le budget de relances et n'est pas bloqué par human_required (S24 17/10 :
# 4 déploiements en 17 min ont épuisé 3/3, déclenché un rollback Tier0 puis 4 incidents human_required,
# et ~490 restart_refused par superviseur, sans fin, sur des processus qui tournaient). Un superviseur
# ABSENT reste une panne et passe par restart_gate.
check_supervisor_effect(){ n="$1"; pat="$2"; script="$3"; local -a sargs=("${@:4}"); if proc "$pat" && supervisor_on_current_root "$pat" "$script" "${sargs[@]}"; then healthy "$n"; return; fi; unstable "$n"; due "$n" || return; if proc "$pat"; then log "service=$n state=stale_runtime action=replace expected=$script budget=exempt"; stop_supervisor "$pat"; wait_supervisor_lock "$n" || { fail "$n"; return; }; else restart_gate "$n" || return; log "service=$n action=start"; fi; start "$n" "$script" "${sargs[@]}"; sleep 3 9>&-; proc "$pat" && supervisor_on_current_root "$pat" "$script" "${sargs[@]}" && healthy "$n" || fail "$n"; }
# A Companion deploy stops and restarts the server itself: never "repair" it meanwhile (S24 11/10: EADDRINUSE,
# 15 concurrent repairs a day, each one cutting the Remote Bridge). The canonical mode also closes the race
# between the outer loop and this repair boundary.
# The helper owns EX on the existing deployment lock until this owner closes
# stdin. Pipes are Bash coprocess descriptors (close-on-exec); repaired daemons
# receive /dev/null as stdin and cannot retain the lease after owner death.
with_repair_lease() (
 local lease_pid lease_in lease_out lease_lock ack rc cause
 # Preserve the helper's open file description in the repair owner as well:
 # even a killed helper cannot drop EX during stop/start. The canonical owner
 # safely creates a missing lock; it never replaces an existing inode.
 local lock_path="${OPENCLAW_HOME:-$HOME/.openclaw}/deploys/companion-deploy.lock"
 if ! python3 "$ROOT/runtime_mode.py" --ensure-deployment-lock 9>&- ||
    [ ! -f "$lock_path" ] || [ -L "$lock_path" ] || ! exec {lease_lock}<>"$lock_path"; then
  log "service=$2 state=runtime_protection_unavailable action=skip_repair"; return 75
 fi
 coproc REPAIR_LEASE { SAMANTHA_DEPLOY_LOCK_FD="$lease_lock" exec python3 "$ROOT/runtime_mode.py" --repair-lease 9>&-; }
 lease_pid=$REPAIR_LEASE_PID; lease_in=${REPAIR_LEASE[1]}; lease_out=${REPAIR_LEASE[0]}
 cleanup_repair_lease(){
  exec {lease_in}>&-; exec {lease_out}<&-
  kill "$lease_pid" 2>/dev/null || true
  wait "$lease_pid" 2>/dev/null || true
  exec {lease_lock}<&-
 }
 trap cleanup_repair_lease EXIT
 if ! IFS= read -r -t 3 ack <&"$lease_out" || [ "$ack" != '{"version":1,"state":"acquired"}' ]; then
  case "${ack:-}" in
   '{"version":1,"state":"refused","cause":"lock_busy"}') cause=lock_busy;;
   '{"version":1,"state":"refused","cause":"emergency_stop"}') cause=emergency_stop;;
   *) cause=unavailable;;
  esac
  log "service=$2 state=runtime_protection_unavailable reason=$cause action=skip_repair"
  return 75
 fi
 "$@"; rc=$?
 return "$rc"
)
# A Companion latched in human_required can only become healthy again by running, and a stopped one has no
# work to interrupt: the latch kept it down until someone typed the restart by hand (S24 03/11 19:03 after a
# reboot, and again at 22:05 after a deploy day). Only for a Companion whose process is absent, at most once per
# LATCHED_RETRY_S, the restart is attempted while the human escalation stays open; a live Companion keeps the latch.
latched_dead_retry(){
 local n="$1" pat="$2" t at
 [ "$n" = companion ] && [ "$(get "$n" escalation none)" = human_required ] && ! proc "$pat" || return 1
 t=$(now); at=$(get "$n" latched_retry_at 0); case "$at" in ''|*[!0-9]*) at=0;; esac
 [ $((t-at)) -ge "$LATCHED_RETRY_S" ] || return 1
 put "$n" latched_retry_at "$t"; log "service=$n action=restart_authorized reason=dead_process_latched_retry interval_s=$LATCHED_RETRY_S"
}
repair_http_effect_under_lease(){
 local n="$1" url="$2" pat="$3" script="$4" grace="$5" stop_wait="$6" waited=0
 # The check and every stop/start remain under the same EX lease. A healthy
 # service discovered here consumes no restart budget.
 if http "$url"; then healthy "$n"; return; fi
 restart_gate "$n" || latched_dead_retry "$n" "$pat" || return
 log "service=$n action=repair"
 if proc "$pat"; then
  pkill -TERM -f "$pat" 9>&- 2>/dev/null || true
  while proc "$pat" && [ "$waited" -lt "$stop_wait" ]; do sleep 2 9>&-; waited=$((waited+2)); done
  if proc "$pat"; then
   log "service=$n state=stop_timeout waited_s=$waited action=kill_stale"
   pkill -KILL -f "$pat" 9>&- 2>/dev/null || true; sleep 2 9>&-
   if proc "$pat"; then fail "$n"; return; fi
  fi
 fi
 ( exec {lease_lock}<&-; start "$n" "$script" ); sleep "$grace" 9>&-
 http "$url" && healthy "$n" || fail "$n"
}
check_http(){
 local n="$1" url="$2" pat="$3" script="$4" grace="${5:-10}" stop_wait="${6:-20}" repair_mode
 if http "$url"; then healthy "$n"; return; fi
 unstable "$n"; repair_mode=$(canonical_mode)
 if [ "$repair_mode" != normal ]; then
  [ "$repair_mode" = deployment ] && repair_mode=deploy_in_progress
  log "service=$n state=${repair_mode:-canonical_mode_unknown} action=skip_repair"; return
 fi
 due "$n" || return
 if proc "$pat"; then
  log "service=$n state=starting_or_unhealthy grace_s=$grace"; sleep "$grace" 9>&-
  if http "$url"; then healthy "$n"; return; fi
 fi
 # Idle proof is outside EX to avoid conflicting with our own lease. A campaign
 # starting after this observation prevents the exclusive acquisition below.
 # It protects work owned by a live Companion only: with no Companion process there is
 # nothing to interrupt, and requiring it kept a dead Companion down (S24 27/10).
 if [ "$n" = companion ] && proc "$pat" && ! companion_idle_proven; then
  log "service=$n state=idle_unproven action=skip_repair"; put "$n" next $(( $(now)+15 )); return
 fi
 with_repair_lease repair_http_under_lease "$n" "$url" "$pat" "$script" "$grace" "$stop_wait"
}

check_adb_effect(){ if adb_ok; then prev=$(get adb status unknown); healthy adb; [ "$prev" = healthy ] || "$ROOT/capability-recovered.py" device.adb 9>&- >/dev/null 2>&1 || true; return; fi; unstable adb; due adb || return; restart_gate adb || return; log 'service=adb action=fast_reconnect'; timeout 4 adb 9>&- connect 127.0.0.1:5556 >/dev/null 2>&1||true; sleep 1 9>&-; adb_ok && healthy adb || fail adb; }
verdict_field(){ python3 - "$D/current.json" "$1" "$2" <<'PY'
import json,sys
try:
 row=json.load(open(sys.argv[1])).get('capabilities',{}).get(sys.argv[2],{})
 print(row.get(sys.argv[3]) or '')
except Exception: print('')
PY
}
check_gateway(){ if http http://127.0.0.1:18789/healthz; then put gateway first_down 0; healthy gateway; return; fi; due gateway || return; first=$(get gateway first_down 0); if [ "$first" -le 0 ]; then first=$(now); put gateway first_down "$first"; put gateway next $((first+30)); log 'service=gateway state=unhealthy owner=companion grace_s=180'; return; fi; age=$(( $(now)-first )); if [ "$age" -lt 180 ]; then put gateway next $(( $(now)+30 )); return; fi; fail gateway; }
check_whatsapp_effect(){
 st=$(verdict_field notification.whatsapp state); reason=$(verdict_field notification.whatsapp reason); prev=$(get whatsapp status unknown)
 if [ "$st" = healthy ]; then
  if [ "$prev" = human_required ]; then "$ROOT/incident-orchestrator.py" recover whatsapp runtime --source health-manager --reason "WhatsApp channel verified connected after relink" >/dev/null 2>&1 || true; "$ROOT/incident-close.sh" WhatsApp "Samantha — WhatsApp est de nouveau connecté et vérifié." || true; fi
  put whatsapp unready_since 0; put whatsapp terminal_notified 0; healthy whatsapp; return
 fi
 # `channel_status_unreadable`: the status CLI did not answer within its budget, which says nothing about
 # the channel (S24 28/10-02/11: 97 % of the `channel_not_connected` episodes were this, 24 false
 # incidents). It neither opens, resets nor escalates an outage; an outage already being measured keeps its
 # start, so the next real reading that is not connected escalates without a new grace.
 [ "$st" = unverified ] && [ "$reason" = channel_status_unreadable ] && return
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
  lock_out=$(immune_action whatsapp bounded-stale-lock-quarantine "$ROOT/whatsapp-lock-recovery.py" --grace-seconds 120 2>&1); lock_rc=$?
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
 [ "$reason" = channel_stopped ] && whatsapp_channel_start "$unavailable_for"
 fail whatsapp
}
# Safe reconnect for a stopped WhatsApp account: OpenClaw's own `channels.start` (what `channels login` calls
# after a relink). It starts whatsapp/default only when no task owns it; a running or reconnecting channel
# answers retry/task-owned and is left alone. No Gateway restart, no session or QR change. The caller's
# `fail` paces it (15 s .. 8 min) and still opens the incident at the 3rd failure if it does not come back.
whatsapp_channel_start_effect(){
 timeout --kill-after=2 25 openclaw gateway call channels.start --timeout 20000 --json \
   --params '{"channel":"whatsapp","accountId":"default"}' 9>&- 2>/dev/null
}
whatsapp_channel_start(){
 local out rc mode outcome
 mode=$(canonical_mode)
 if [ "$mode" != normal ]; then log "service=whatsapp state=${mode:-canonical_mode_unknown} action=skip_channel_start"; return 0; fi
 out=$(IMMUNE_OBSERVATION="openclaw channels status reports WhatsApp default enabled but stopped for ${1:-0} s: no OpenClaw task owns its reconnection. The bounded operation calls the Gateway method channels.start for whatsapp/default only; a running or reconnecting channel is left untouched; no Gateway restart." immune_action whatsapp bounded-channel-start whatsapp_channel_start_effect); rc=$?
 if [ "$rc" -eq 75 ]; then
  # Same rule as the Companion repair: the AI gate is reached through the Companion; without it the
  # idempotent start runs directly. With a live Companion a refusal waits for the next paced attempt.
  if proc 'dist/companion/[s]erver.js'; then log "service=whatsapp state=ai_gate_refused action=wait_channel_start"; return 0; fi
  log "service=whatsapp action=direct_repair reason=ai_gate_unreachable"
  out=$(whatsapp_channel_start_effect); rc=$?
 fi
 outcome=$(printf '%s' "$out" | python3 -c 'import json,re,sys
try:
 o=json.load(sys.stdin); oc=(o.get("outcome") or {}) if isinstance(o,dict) else {}
 ok=lambda v:isinstance(v,str) and re.fullmatch(r"[a-z-]{1,24}",v)
 v=oc.get("status") if isinstance(oc,dict) else None; r=oc.get("reason") if isinstance(oc,dict) else None
 print((v+(":"+r if ok(r) else "")) if ok(v) else ("error" if isinstance(o,dict) and o.get("ok") is False else "unknown"))
except Exception: print("unreadable")' 2>/dev/null)
 log "service=whatsapp action=channel_start rc=$rc outcome=${outcome:-unreadable}"
 return 0
}
# P0-4: Gateway memory guard (measured thresholds, sustained 10 min, idle proof, 6 h cooldown,
# receipt health/gateway-memory-guard.json). Graceful restart through the existing Companion route.
gateway_memory_restart_selected(){
 local out
 # Revalidate pressure, idle proof and cooldown after the model's decision.
 out=$(timeout 15 python3 "$ROOT/gateway-memory-guard.py" 9>&- 2>/dev/null) || return 1
 case "$out" in *'"action": "restart_requested"'*) ;; *) return 0;; esac
 restart_gate gateway_memory || return
 log "service=gateway_memory state=restart_requested owner=companion detail=$out"
 ( set -o pipefail
   timeout --kill-after=5 240 curl -fsS --max-time 230 \
      -X POST -H 'Content-Type: application/json' -d '{}' \
      http://127.0.0.1:8765/v1/runtime/restart 2>&1 \
   | python3 "$ROOT/bounded-log.py" "$D/gateway-memory-restart.log" --stream
 )
}
check_gateway_memory_effect(){
 due gateway_memory || return
 put gateway_memory next $(( $(now)+60 ))
 # Observation alone neither authorizes a restart nor consumes its cooldown.
 out=$(timeout 15 python3 "$ROOT/gateway-memory-guard.py" --observe 9>&- 2>/dev/null) || return
 case "$out" in
  *'"action": "observe_only"'*)
   immune_action gateway_memory bounded-idle-gateway-restart gateway_memory_restart_selected 9>&- </dev/null >/dev/null 2>&1 &
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
 if immune_action android_phantom_headroom bounded-phantom-limit-restore timeout 5 adb 9>&- -s 127.0.0.1:5556 shell device_config put activity_manager max_phantom_processes "$PHANTOM_HEADROOM_TARGET" >/dev/null 2>&1; then
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
check_sshd_effect(){
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
check_slack_bridge_effect(){
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
 # Même règle que check_supervisor : réaligner un pont vivant sur la nouvelle release est gratuit ; un pont
 # absent ou dégradé sur la release courante est une panne et passe par le budget.
 if proc '[c]law-slack-bridge.mjs' && ! slack_bridge_on_current_root; then
   log "service=slack_bridge state=stale_runtime action=replace expected_root=$ROOT budget=exempt"
   stop_slack_bridge
 else
   restart_gate slack_bridge || return
   if proc '[c]law-slack-bridge.mjs'; then
     log 'service=slack_bridge state=degraded action=restart'
     stop_slack_bridge
   else
     log 'service=slack_bridge action=start'
   fi
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
# Q13 cooperates with this existing cycle. No separate timer, scheduler or worker loop.
# The private people-trusted owner resolves the pinned PB root and keeps pending closed.
check_qa_queue(){
 local result summary state dispatched waiting signature previous
 [ "$(canonical_mode)" = normal ] || return 0
 # 14s + at most 1s kill grace; one bounded admission per existing cycle.
 # The bounded pipe never retains an arbitrary helper response in shell memory.
 result=$(set -o pipefail; timeout --kill-after=1 14 python3 "$ROOT/people-trusted.py" qa-queue-tick 9>&- 2>/dev/null | head -c 4097) || result=''
 summary=$(printf '%s' "$result" | python3 -c '
import json,sys
try:
 raw=sys.stdin.buffer.read(4097)
 if len(raw)>4096:raise ValueError()
 value=json.loads(raw)
 if not isinstance(value,dict) or set(value)!={"state","dispatched","waiting"}:raise ValueError()
 state=value["state"];dispatched=value["dispatched"];waiting=value["waiting"]
 if state not in {"NOT_READY","IDLE","WAITING","STARTED","VERIFY_REQUIRED","UNAVAILABLE"}:raise ValueError()
 if type(dispatched) is not int or dispatched not in (0,1) or type(waiting) is not int or not 0<=waiting<=500:raise ValueError()
 if (state=="STARTED") != (dispatched==1):raise ValueError()
 print(state,dispatched,waiting)
except Exception:print("UNAVAILABLE 0 0")
' 9>&- 2>/dev/null) || summary='UNAVAILABLE 0 0'
 read -r state dispatched waiting <<<"$summary"
 signature="$state:$dispatched:$waiting";previous=$(get qa_queue status unknown)
 if [ "$signature" != "$previous" ]; then
  put qa_queue status "$signature"
  log "service=qa_queue state=$state dispatched=$dispatched waiting=$waiting"
 fi
 return 0
}
check_supervisor(){
 local rc=0
 if proc "$2" && supervisor_on_current_root "$2" "$3" "${@:4}"; then healthy "$1"; return; fi
 IMMUNE_OBSERVATION="$(immune_supervisor_facts "$1" "$2" "$3" 2>/dev/null)" immune_action "$1" bounded-supervisor-restore check_supervisor_effect "$@" || rc=$?
 # core-services-watchdog --gateway-only covers the Gateway precisely while no Companion process exists,
 # which is also when the AI gate (reached through the Companion) cannot answer. Same rule as the Companion
 # repair below: with no Companion process the bounded effect runs directly (restart budget, backoff).
 if [ "$rc" -eq 75 ] && [ "$1" = core_services_watchdog ] && ! proc 'dist/companion/[s]erver.js'; then
  log "service=$1 action=direct_repair reason=ai_gate_unreachable"
  check_supervisor_effect "$@" || true
 fi
 return 0
}
# The AI gate reaches its models only through the Companion itself (/v1/intent/interpret): with no
# Companion process the gate always answers unavailable, whether the Gateway runs or not, and the
# Companion never came back (S24 27/10, after a reboot and again at 22:27 with the Gateway up).
# With no Companion process the existing bounded repair runs directly (same lease, restart budget
# and canonical mode); a live Companion is never replaced without the AI.
repair_http_under_lease(){
 local rc
 if http "$2"; then healthy "$1"; return; fi
 IMMUNE_OBSERVATION="$1 HTTP probe failed: $2 did not answer within 3 s (curl -fsS). The bounded operation restarts only this service under the existing lease and budget, then probes it again." immune_action "$1" bounded-http-service-restore repair_http_effect_under_lease "$@"; rc=$?
 [ "$rc" -eq 75 ] || return 0
 if [ "$1" = companion ] && ! proc "$3"; then
  log "service=$1 action=direct_repair reason=ai_gate_unreachable"
  repair_http_effect_under_lease "$@"; return 0
 fi
 log "service=$1 state=ai_gate_refused action=wait retry_in_s=60"; put "$1" next $(( $(now)+60 ))
}
check_adb(){
 if adb_ok; then check_adb_effect; return; fi
 IMMUNE_OBSERVATION="adb -s 127.0.0.1:5556 get-state did not return device within 3 s. The bounded operation reconnects only the trusted local ADB endpoint, then checks get-state again." immune_action adb bounded-trusted-adb-reconnect check_adb_effect || true
}
check_whatsapp(){
 # Readiness is observed by the existing owner; only its mutating recovery branch
 # is gated below, so healthy checks and human auth boundaries remain available.
 check_whatsapp_effect
}
check_gateway_memory(){ check_gateway_memory_effect; }

check_sshd(){
 if ssh_ok; then healthy sshd; return; fi
 IMMUNE_OBSERVATION="sshd probe failed: the local SSH server did not answer. The bounded operation restarts only sshd under the existing budget, then probes it again." immune_action sshd bounded-sshd-restore check_sshd_effect || true
}
check_slack_bridge(){
 local readiness
 "$ROOT/claw-slack-bridge-health.py" 9>&- >/dev/null 2>&1; readiness=$?
 if { [ "$readiness" -eq 0 ] || [ "$readiness" -eq 3 ]; } && slack_bridge_on_current_root; then
   check_slack_bridge_effect; return
 fi
 if [ "$readiness" -eq 2 ] && ! proc '[c]law-slack-bridge.mjs'; then check_slack_bridge_effect; return; fi
 IMMUNE_OBSERVATION="slack_bridge readiness probe exit=$readiness (0 ready, 2 down, 3 degraded); bridge process present=$(proc '[c]law-slack-bridge.mjs' && echo yes || echo no). The bounded operation restarts only the Slack bridge on the current release, then probes readiness again." immune_action slack_bridge bounded-slack-bridge-restore check_slack_bridge_effect || true
}

# Service states and backoffs describe processes of the boot that wrote them. After a
# reboot they said "healthy" for dead services and kept a 15 min backoff (S24 27/10):
# on a new boot each service state becomes unknown and is checked again at once.
reset_states_on_new_boot(){
 local boot previous f n
 boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || return 0
 [ -n "$boot" ] || return 0
 previous=$(cat "$S/boot_id" 2>/dev/null)
 [ "$previous" = "$boot" ] && return 0
 # No record yet (first start of this version): the states' boot is unknown, keep them.
 if [ -z "$previous" ]; then printf '%s' "$boot" >"$S/boot_id"; return 0; fi
 for f in "$S"/*.status; do
  [ -e "$f" ] || continue
  case "$(cat "$f" 2>/dev/null)" in
   healthy|degraded) n=$(basename "$f" .status); put "$n" status unknown; put "$n" failures 0; put "$n" next 0;;
  esac
 done
 printf '%s' "$boot" >"$S/boot_id"
 log 'event=new_boot action=reset_service_states'
}
reset_states_on_new_boot

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
 # Gateway fallback while no Companion lives (the Companion's own watchdog owns it otherwise); never the
 # Companion itself, which check_http below owns. Anchored pattern: test-core-services-watchdog.sh (CI, or
 # a localci-s24 diagnostic on this phone) must never count as this supervisor, nor be stopped as stale.
 check_supervisor core_services_watchdog '/[c]ore-services-watchdog[.]sh( |$)' "$ROOT/core-services-watchdog.sh" --gateway-only
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
 check_qa_queue
 check_runtime_drift
 sleep 15 9>&-
done
