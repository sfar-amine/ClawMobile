#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"
STATE="$HOME/.openclaw/bootstrap"
LOG="$STATE/bootstrap.log"
mkdir -p "$STATE"
exec 9>"$STATE/bootstrap.lock"
flock -n 9 || exit 0
log(){ printf '%s component=bootstrap severity=%s event=%s result=%s detail="%s"\n' "$(date -Iseconds)" "$1" "$2" "$3" "$4" >>"$LOG"; }
start_if_missing(){ pattern="$1"; script="$2"; name="$3"; if pgrep -f "$pattern" >/dev/null; then log INFO present ok "$name already running"; return 0; fi; nohup "$script" >>"$STATE/$name.log" 2>&1 & sleep 3; if pgrep -f "$pattern" >/dev/null; then log INFO start ok "$name started"; else log ERROR start failed "$name did not start"; return 1; fi; }
rc=0
start_if_missing 'openclaw-gateway' "$ROOT/gateway-start.sh" gateway || rc=1
# Retry gateway after Android/Termux settles; cold boot can be slower.
if ! pgrep -f 'openclaw-gateway' >/dev/null; then sleep 15; start_if_missing 'openclaw-gateway' "$ROOT/gateway-start.sh" gateway_retry || rc=1; fi
start_if_missing 'dist/companion/server.js' "$ROOT/companion-server.sh" companion || rc=1
start_if_missing 'remote-desktop-watchdog.sh' "$ROOT/remote-desktop-watchdog.sh" remote_watchdog || rc=1
start_if_missing 'adb-recovery-watchdog.sh' "$ROOT/adb-recovery-watchdog.sh" adb_watchdog || rc=1
"$ROOT/chat-continuity-restore.sh" || rc=1
log INFO complete "$([ "$rc" -eq 0 ] && echo ok || echo degraded)" "idempotent bootstrap completed"
exit "$rc"
