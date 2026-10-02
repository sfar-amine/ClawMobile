#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR="${ADB_RECOVERY_HOME:-/data/data/com.termux/files/home}"
RUNTIME_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STATE_DIR="$HOME_DIR/.openclaw/watchdogs"
LOG="$STATE_DIR/adb-recovery.log"
STATE="$STATE_DIR/adb-recovery.state"
HELP_NOTIFY="$STATE_DIR/adb-help-notified"
READINESS_STATE="$STATE_DIR/adb-recovery-readiness.state"
READINESS_FAILURES="$STATE_DIR/adb-recovery-readiness.failures"
READINESS_NOTIFY="$STATE_DIR/adb-recovery-readiness-notified"
READINESS_HELPER="${ADB_RECOVERY_READINESS_HELPER:-$RUNTIME_DIR/adb-recovery-readiness.py}"
LOCK="$STATE_DIR/adb-recovery.lock"
INTERVAL="${ADB_RECOVERY_INTERVAL:-60}"
HELP_AFTER="${ADB_RECOVERY_HELP_AFTER:-3}"
READINESS_HELP_AFTER="${ADB_RECOVERY_READINESS_HELP_AFTER:-3}"
READINESS_DISCOVER_TIMEOUT="${ADB_RECOVERY_READINESS_DISCOVER_TIMEOUT:-2}"
MAX_LOOPS="${ADB_RECOVERY_MAX_LOOPS:-0}"
STABLE_PORT="${ADB_RECOVERY_STABLE_PORT:-5556}"
mkdir -p "$STATE_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0
# Keep the singleton lock for the full watchdog lifetime. Close fd 9 only on spawned descendants when needed.
log(){ printf '%s component=adb-recovery severity=%s event=%s result=%s detail="%s"\n' "$(date -Iseconds)" "$1" "$2" "$3" "$4" >>"$LOG"; }
adb_up(){ timeout 3 adb 9>&- -s "127.0.0.1:$STABLE_PORT" get-state 2>/dev/null | grep -qx device; }
adb_ep_up(){ timeout 3 adb 9>&- -s "$1" get-state 2>/dev/null | grep -qx device; }
ep_matches_expected(){
  ep="$1"; expected="$(cat "$STATE_DIR/adb-expected-serial" 2>/dev/null || true)"
  [ -n "$expected" ] || return 1
  actual="$(timeout 4 adb 9>&- -s "$ep" shell getprop ro.serialno 2>/dev/null | tr -d '\r\n')"
  [ "$actual" = "$expected" ]
}
wifi_up(){
  # Android may hide /sys/class/net and netlink from Termux. Try several
  # non-invasive signals; a positive result is enough to start recovery.
  [ "$(getprop wlan.driver.status 2>/dev/null)" = ok ] && return 0
  dumpsys wifi 2>/dev/null | grep -Eqi 'Wi-Fi is enabled|mWifiEnabled=true|WIFI_STATE_ENABLED|connected.*ssid|mNetworkInfo.*CONNECTED' && return 0
  # Samsung/Android 16 can hide Wi-Fi state from the Termux UID. Network
  # reachability is sufficient for ADB recovery attempts; it avoids a false
  # waiting_wifi state without claiming which transport provides connectivity.
  timeout 4 ping -c1 1.1.1.1 >/dev/null 2>&1 && return 0
  return 1
}
notify_info(){ "$RUNTIME_DIR/incident-notify.sh" info "$1"; }

readiness_try_repair(){
  reason="$1"
  case "$reason" in
    wifi_disabled_recovery_standby)
      timeout 5 adb 9>&- -s "127.0.0.1:$STABLE_PORT" shell svc wifi enable >/dev/null 2>&1 || true
      sleep 2 9>&-
      ;;&
    wireless_debugging_disabled|wifi_disabled_recovery_standby)
      timeout 5 adb 9>&- -s "127.0.0.1:$STABLE_PORT" shell settings put global adb_wifi_enabled 1 >/dev/null 2>&1 || true
      sleep 2 9>&-
      return 0
      ;;
    *) return 1 ;;
  esac
}

readiness_human_required(){
  reason="$1"
  ORCH="$RUNTIME_DIR/incident-orchestrator.py"
  iid="$("$ORCH" open device.adb.recovery_readiness runtime --source adb-recovery-watchdog --summary "ADB recovery readiness requires owner action" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null || true)"
  [ -n "$iid" ] || return 1
  "$ORCH" transition "$iid" human_required --source adb-recovery-watchdog --human-boundary --reason "$reason" >/dev/null 2>&1 || return 1
  if "$RUNTIME_DIR/incident-notify.sh" human_required       "Samantha — la reprise automatique ADB est épuisée ($reason)."       "Sur le S24, active le Wi-Fi puis Paramètres > Options développeur > Débogage sans fil. Je vérifierai automatiquement le retour à l'état prêt."; then
    printf '%s' "$iid" >"$READINESS_NOTIFY"
    log WARN readiness human_required "owner action required incident_id=$iid reason=$reason"
    return 0
  fi
  return 1
}

readiness_recover_incident(){
  if [ ! -s "$READINESS_NOTIFY" ]; then rm -f "$READINESS_NOTIFY"; return 0; fi
  "$RUNTIME_DIR/incident-orchestrator.py" recover device.adb.recovery_readiness runtime     --source adb-recovery-watchdog --reason "Wireless Debugging recovery path verified" >/dev/null 2>&1 || true
  "$RUNTIME_DIR/incident-close.sh"     "ADB recovery readiness"     "Samantha — la capacité de reprise ADB est rétablie et vérifiée." >/dev/null 2>&1 || true
  rm -f "$READINESS_NOTIFY"
}

readiness_tick(){
  [ -x "$READINESS_HELPER" ] || return 0
  row="$("$READINESS_HELPER" --json --discover-timeout "$READINESS_DISCOVER_TIMEOUT" 9>&- 2>/dev/null || true)"
  [ -n "$row" ] || return 0
  state="$(printf '%s' "$row" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state","unverified"))' 2>/dev/null || echo unverified)"
  reason="$(printf '%s' "$row" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason","unknown"))' 2>/dev/null || echo unknown)"
  requires_owner="$(printf '%s' "$row" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("requires_owner_action",False) else "false")' 2>/dev/null || echo false)"
  auto_repairable="$(printf '%s' "$row" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("auto_repairable",False) else "false")' 2>/dev/null || echo false)"
  previous="$(cat "$READINESS_STATE" 2>/dev/null || echo unknown)"
  failures="$(cat "$READINESS_FAILURES" 2>/dev/null || echo 0)"
  case "$failures" in ''|*[!0-9]*) failures=0;; esac
  case "$state" in
    ready)
      readiness_recover_incident
      [ "$previous" = ready ] || log INFO readiness ready "trusted Wireless Debugging recovery path verified"
      printf 0 >"$READINESS_FAILURES"
      printf ready >"$READINESS_STATE"
      ;;
    degraded)
      printf degraded >"$READINESS_STATE"
      if [ "$auto_repairable" = true ]; then
        if readiness_try_repair "$reason"; then
          repaired_row="$("$READINESS_HELPER" --json --discover-timeout "$READINESS_DISCOVER_TIMEOUT" 9>&- 2>/dev/null || true)"
          repaired_state="$(printf '%s' "$repaired_row" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state","unverified"))' 2>/dev/null || echo unverified)"
          repaired_reason="$(printf '%s' "$repaired_row" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason","unknown"))' 2>/dev/null || echo unknown)"
          if [ "$repaired_state" = ready ]; then
            readiness_recover_incident
            log INFO readiness repaired "automatic recovery readiness repair verified"
            printf 0 >"$READINESS_FAILURES"
            printf ready >"$READINESS_STATE"
            return 0
          fi
          [ "$repaired_state" = degraded ] && reason="$repaired_reason"
        fi
      fi
      if [ "$requires_owner" = true ]; then
        failures=$((failures+1))
        printf '%s' "$failures" >"$READINESS_FAILURES"
        if [ "$previous" != degraded ]; then
          log WARN readiness degraded "recovery readiness degraded reason=$reason failures=$failures"
        fi
        if [ "$failures" -ge "$READINESS_HELP_AFTER" ] && [ ! -s "$READINESS_NOTIFY" ]; then
          rm -f "$READINESS_NOTIFY"
          readiness_human_required "$reason" || true
        fi
      else
        printf 0 >"$READINESS_FAILURES"
        [ "$previous" = degraded ] || log INFO readiness standby "non-critical recovery warning reason=$reason owner_action=false"
      fi
      ;;
    *)
      printf 0 >"$READINESS_FAILURES"
      printf unverified >"$READINESS_STATE"
      [ "$previous" = unverified ] || log WARN readiness unverified "recovery readiness could not be verified reason=$reason"
      ;;
  esac
}

recover_adb(){
  adb 9>&- start-server >/dev/null 2>&1 || true
  adb 9>&- connect "127.0.0.1:$STABLE_PORT" >/dev/null 2>&1 || true
  adb_up && return 0

  # Retry the last trusted dynamic endpoint, then rediscover the current
  # Android Wireless Debugging endpoint through local mDNS.
  candidates=""
  if [ -s "$STATE_DIR/adb-last-endpoint" ]; then
    candidates="$(cat "$STATE_DIR/adb-last-endpoint" 2>/dev/null)"
  fi
  expected="$(cat "$STATE_DIR/adb-expected-serial" 2>/dev/null || true)"
  if [ -n "$expected" ]; then
    discovered="$("$RUNTIME_DIR/adb-discover-endpoint.py" --serial "$expected" --timeout 4 2>/dev/null || true)"
    candidates="$(printf '%s\n%s\n' "$candidates" "$discovered" | awk 'NF && !seen[$0]++')"
  fi
  while IFS= read -r ep; do
    [ -n "$ep" ] || continue
    case "$ep" in
      127.0.0.1:$STABLE_PORT|localhost:$STABLE_PORT) continue ;;
      127.0.0.1:[0-9]*|localhost:[0-9]*|[0-9]*.[0-9]*.[0-9]*.[0-9]*:[0-9]*)
        adb 9>&- connect "$ep" >/dev/null 2>&1 || true
        if adb_ep_up "$ep" && ep_matches_expected "$ep"; then
          printf '%s' "$ep" >"$STATE_DIR/adb-last-endpoint"
          adb 9>&- -s "$ep" tcpip "$STABLE_PORT" >/dev/null 2>&1 || true
          sleep 2 9>&-
          adb 9>&- connect "127.0.0.1:$STABLE_PORT" >/dev/null 2>&1 || true
          adb_up && return 0
        fi
        ;;
    esac
  done <<EOF
$candidates
EOF
  return 1
}
prev="$(cat "$STATE" 2>/dev/null || printf unknown)"
recovery_tries=0
loops=0
log INFO start ok "watchdog started previous=$prev"
while :; do
  loops=$((loops+1))
  printf '%s' "$(date +%s)" >"$HOME_DIR/.openclaw/health/adb-watchdog.heartbeat"
  if adb_up; then
    readiness_tick
    if [ "$prev" != up ]; then
      log INFO recovered ok "ADB operational"
      notify_info "Samantha — ADB est de nouveau opérationnel. La récupération automatique est terminée et vérifiée." && rm -f "$HELP_NOTIFY"
      "$RUNTIME_DIR/capability-recovered.py" device.adb >/dev/null 2>&1 || log WARN recovery_dispatch failed "device.adb recovery dispatch failed"
      "$RUNTIME_DIR/chat-continuity-restore.sh" >/dev/null 2>&1 || log WARN continuity_restore failed "deferred ChatGPT restore failed"
    fi
    printf up >"$STATE"; prev=up; recovery_tries=0
  elif ! wifi_up; then
    if [ "$prev" != waiting_wifi ]; then
      log WARN blocked waiting_wifi "ADB unavailable and Wi-Fi required"
      boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
      iid=$("$RUNTIME_DIR/incident-orchestrator.py" open adb "boot-$boot_id" --source adb-watchdog --summary "ADB unavailable and network prerequisite missing" 2>/dev/null | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')
      "$RUNTIME_DIR/incident-orchestrator.py" observe "$iid" network_prerequisite_missing --source adb-watchdog --json '{"wifi_or_network":false}' >/dev/null 2>&1 || true
    fi
    printf waiting_wifi >"$STATE"; prev=waiting_wifi; recovery_tries=0
  else
    recovery_tries=$((recovery_tries+1))
    log INFO recovery attempt "Wi-Fi available; trying trusted ADB recovery attempt=$recovery_tries"
    if recover_adb; then
      log INFO recovered ok "ADB recovered automatically"
      printf up >"$STATE"; prev=up; recovery_tries=0
      notify_info "Samantha — ADB est de nouveau opérationnel. La récupération automatique est terminée et vérifiée." && rm -f "$HELP_NOTIFY"
      "$RUNTIME_DIR/capability-recovered.py" device.adb >/dev/null 2>&1 || log WARN recovery_dispatch failed "device.adb recovery dispatch failed"
      "$RUNTIME_DIR/chat-continuity-restore.sh" >/dev/null 2>&1 || log WARN continuity_restore failed "deferred ChatGPT restore failed"
    else
      if [ "$prev" != recovery_needed ]; then log WARN recovery pending "trusted automatic ADB recovery did not succeed"; fi
      if [ "$recovery_tries" -eq "$HELP_AFTER" ]; then
        boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
        iid=$("$RUNTIME_DIR/incident-orchestrator.py" open adb "boot-$boot_id" --source adb-watchdog --summary "trusted ADB recovery exhausted" 2>/dev/null | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')
        "$RUNTIME_DIR/incident-orchestrator.py" observe "$iid" deterministic_exhausted --source adb-watchdog --json "{\"attempts\":$recovery_tries}" >/dev/null 2>&1 || true
        log WARN escalation orchestrator "deterministic ADB recovery exhausted incident_id=$iid"
      fi
      printf recovery_needed >"$STATE"; prev=recovery_needed
    fi
  fi
  if [ "$MAX_LOOPS" -gt 0 ] && [ "$loops" -ge "$MAX_LOOPS" ]; then break; fi
  sleep "$INTERVAL" 9>&-
done
