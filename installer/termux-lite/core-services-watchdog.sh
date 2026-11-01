#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"; D="$HOME/.openclaw/watchdogs"; LOG="$D/core-services.log"
mkdir -p "$D"; exec 9>"$D/core-services.lock"; flock -n 9 || exit 0; exec 9>&-
# Bounded log: one previous generation only.
log(){ [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 262144 ] && mv -f "$LOG" "$LOG.1"; printf '%s component=core-services %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
alive_gw(){ pgrep -f 'openclaw-gateway' >/dev/null; }
alive_cp(){ pgrep -f 'dist/companion/server.js' >/dev/null; }
heal(){ n="$1"; f="$2"; if ! "alive_$n"; then log "event=down service=$n"; nohup "$f" >>"$D/$n-process.log" 2>&1 </dev/null & sleep 5; if "alive_$n"; then log "event=recovered service=$n"; "$ROOT/incident-notify.sh" core_service "Samantha — service $n récupéré automatiquement." >/dev/null 2>&1 & else log "event=recovery_failed service=$n"; "$ROOT/incident-notify.sh" human_required "Samantha — service $n indisponible après tentative de récupération automatique." >/dev/null 2>&1 & fi; fi; }

# A Gateway whose in-process start/restart failed can stay alive without a server
# (« Process will stay alive », port closed, lock released): a present process is
# not enough. Same port and loopback bind as gateway-start.sh; bash /dev/tcp probe.
GW_PORT="${GATEWAY_PORT:-${CLAWMOBILE_GATEWAY_PORT:-18789}}"
GW_GRACE_S=60            # never act on a Gateway younger than this (startup can be slow)
GW_STRIKES_NEEDED=2      # consecutive observations, port closed and grace exceeded
GW_STOP_WAIT_S="${CORE_SERVICES_GATEWAY_STOP_WAIT_S:-10}"; [[ "$GW_STOP_WAIT_S" =~ ^([1-9]|[12][0-9]|30)$ ]] || GW_STOP_WAIT_S=10
INTERVAL_S="${CORE_SERVICES_WATCHDOG_INTERVAL_S:-20}"; [[ "$INTERVAL_S" =~ ^[0-9]{1,3}$ ]] || INTERVAL_S=20
TICKS="${CORE_SERVICES_WATCHDOG_TICKS:-0}"; [[ "$TICKS" =~ ^[0-9]{1,4}$ ]] || TICKS=0   # 0 = forever (tests bound it)
GW_SEEN=""; GW_STRIKES=0
CAUSE=gateway_alive_port_closed
gw_port_open(){ timeout 3 "$BASH" -c ': </dev/tcp/127.0.0.1/'"$GW_PORT" 2>/dev/null; }
proc_start(){ local s; s="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1; s="${s##*) }"; set -- $s; printf '%s' "${20:-}"; }
# Same recognition as the Companion (isGatewayRuntimeCommand), minus the broad run.sh;
# a shell -c wrapper that merely mentions the Gateway is never a target.
is_gw_command(){
  local -a t; read -ra t <<<"$1"; local i j n=${#t[@]} b
  for ((i=0;i<n;i++)); do case "${t[i]##*/}" in bash|sh|zsh) for ((j=i+1;j<n&&j<=i+5;j++)); do case "${t[j]}" in -c|-lc|-cl) return 1;; esac; done; break;; esac; done
  for ((i=0;i<n;i++)); do b="${t[i]##*/}"
    case "$b" in openclaw-gateway|gateway-start.sh) return 0;;
      openclaw|openclaw.mjs) for ((j=i+1;j<n&&j<=i+5;j++)); do [ "${t[j]}" = gateway ] && return 0; done;; esac
  done; return 1
}
# Prints "pid:starttime:age" per Gateway process. Unknown age counts as young (fail safe).
gw_candidates(){
  local pid et args st
  while read -r pid et args; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue; [ "$pid" = "$$" ] || [ "$pid" = "$BASHPID" ] && continue
    is_gw_command "$args" || continue
    st="$(proc_start "$pid")" && [ -n "$st" ] || continue
    [[ "$et" =~ ^[0-9]+$ ]] || et=0
    printf '%s:%s:%s\n' "$pid" "$st" "$et"
  done < <(ps -eo pid=,etimes=,args= 2>/dev/null)
}
# The Companion's runtime repair, companion-deploy.sh and QA campaigns all own the
# same deploys/companion-deploy.lock; the Companion takes it through this exact
# helper before any stop/start. Reusing it means: deploy, campaign or Companion
# restart in progress (lock_busy) or Tier0 emergency stop = no action here.
lease_open(){
  LEASE_CAUSE=unavailable
  [ -f "$ROOT/runtime_mode.py" ] || return 1
  coproc GWLEASE { exec python3 "$ROOT/runtime_mode.py" --repair-lease 2>/dev/null; }
  LEASE_R=${GWLEASE[0]}; LEASE_W=${GWLEASE[1]}; LEASE_PID=$GWLEASE_PID
  local ack=""; IFS= read -r -t 10 ack <&"$LEASE_R" || true
  [ "$ack" = '{"version":1,"state":"acquired"}' ] && return 0
  case "$ack" in *'"cause":"lock_busy"'*) LEASE_CAUSE=lock_busy;; *'"cause":"emergency_stop"'*) LEASE_CAUSE=emergency_stop;; esac
  lease_close; return 1
}
# EOF on the helper's stdin releases the exclusive lock.
lease_close(){ local i; { exec {LEASE_W}>&- {LEASE_R}<&-; } 2>/dev/null
  for ((i=0;i<6;i++)); do kill -0 "$LEASE_PID" 2>/dev/null || break; sleep 0.5; done
  kill -KILL "$LEASE_PID" 2>/dev/null; wait "$LEASE_PID" 2>/dev/null; return 0; }
same_proc(){ [ "$(proc_start "${1%%:*}")" = "$(cut -d: -f2 <<<"$1")" ]; }
recover_orphan_gw(){
  local ids="$1" id pid i alive launched
  if ! lease_open; then log "event=gateway_recovery_deferred cause=$CAUSE reason=$LEASE_CAUSE"; return 0; fi
  # Re-check under the lease: someone may have repaired it meanwhile.
  if gw_port_open; then lease_close; log "event=gateway_port_recovered cause=$CAUSE"; return 0; fi
  for id in $ids; do same_proc "$id" || { lease_close; log "event=gateway_recovery_skipped cause=$CAUSE reason=process_changed"; return 0; }; done
  for id in $ids; do pid=${id%%:*}; log "event=gateway_stop cause=$CAUSE pid=$pid age_s=${id##*:} signal=TERM"; kill -TERM "$pid" 2>/dev/null; done
  for ((i=0;i<GW_STOP_WAIT_S;i++)); do alive=""; for id in $ids; do same_proc "$id" && alive=1; done; [ -z "$alive" ] && break; sleep 1; done
  for id in $ids; do same_proc "$id" && { log "event=gateway_stop cause=$CAUSE pid=${id%%:*} signal=KILL"; kill -KILL "${id%%:*}" 2>/dev/null; }; done
  sleep 1; alive=""; for id in $ids; do same_proc "$id" && alive="$alive ${id%%:*}"; done
  if [ -n "$alive" ]; then lease_close; log "event=gateway_recovery_failed cause=$CAUSE reason=stop_failed pids=${alive# }"
    "$ROOT/incident-notify.sh" human_required "Samantha — Gateway sans port impossible à arrêter automatiquement." >/dev/null 2>&1 & return 0; fi
  # Existing start path. The child must not inherit the lease pipe (it would hold the lock forever).
  ( exec {LEASE_W}>&- {LEASE_R}<&- 9>&-; exec nohup "$ROOT/gateway-start.sh" >>"$D/gw-process.log" 2>&1 </dev/null ) & launched=$!
  sleep 5; lease_close
  if kill -0 "$launched" 2>/dev/null || alive_gw; then log "event=gateway_restarted cause=$CAUSE stopped=$(for id in $ids; do printf '%s,' "${id%%:*}"; done | sed 's/,$//')"
    "$ROOT/incident-notify.sh" core_service "Samantha — Gateway sans port relancée automatiquement." >/dev/null 2>&1 &
  else log "event=gateway_recovery_failed cause=$CAUSE reason=start_failed"
    "$ROOT/incident-notify.sh" human_required "Samantha — Gateway indisponible après relance automatique (processus sans port)." >/dev/null 2>&1 &
  fi
}
check_gw_port(){
  local c ids="" young=""
  if ! alive_gw || gw_port_open; then GW_SEEN=""; GW_STRIKES=0; return 0; fi
  while IFS= read -r c; do [ -n "$c" ] || continue; if [ "${c##*:}" -lt "$GW_GRACE_S" ]; then young=1; else ids="$ids $c"; fi; done < <(gw_candidates)
  ids="${ids# }"
  # A young Gateway (any starter) or no identifiable PID: never act.
  if [ -n "$young" ] || [ -z "$ids" ]; then GW_SEEN=""; GW_STRIKES=0; return 0; fi
  local key; key="$(for c in $ids; do printf '%s ' "${c%:*}"; done)"
  if [ "$key" = "$GW_SEEN" ]; then GW_STRIKES=$((GW_STRIKES+1)); else GW_SEEN="$key"; GW_STRIKES=1; fi
  log "event=gateway_port_closed cause=$CAUSE port=$GW_PORT strike=$GW_STRIKES/$GW_STRIKES_NEEDED pids=$(for c in $ids; do printf '%s,' "${c%%:*}"; done | sed 's/,$//')"
  [ "$GW_STRIKES" -ge "$GW_STRIKES_NEEDED" ] || return 0
  GW_SEEN=""; GW_STRIKES=0
  recover_orphan_gw "$ids"
}

log 'event=start result=ok'
tick=0
while :; do heal gw "$ROOT/gateway-start.sh"; check_gw_port; heal cp "$ROOT/companion-server.sh"; tick=$((tick+1)); [ "$TICKS" -gt 0 ] && [ "$tick" -ge "$TICKS" ] && break; sleep "$INTERVAL_S"; done
