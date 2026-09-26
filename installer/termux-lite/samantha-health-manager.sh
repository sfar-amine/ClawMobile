#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"; D="$HOME/.openclaw/health"; LOG="$D/health.log"; mkdir -p "$D"; export TMPDIR="$HOME/.cache/tmp"
exec 9>"$D/health.lock"; flock -n 9 || exit 0; exec 9>&-
log(){ printf '%s component=health-manager %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
proc(){ pgrep -f "$1" >/dev/null 2>&1; }
http(){ timeout 3 curl -fsS "$1" >/dev/null 2>&1; }
adb_ok(){ timeout 3 adb -s 127.0.0.1:5555 get-state 2>/dev/null | grep -qx device; }
start(){ name="$1"; script="$2"; log "service=$name action=start"; nohup "$script" >>"$D/$name.stderr.log" 2>&1 </dev/null & }
ensure_supervisor(){ name="$1"; pat="$2"; script="$3"; proc "$pat" && return; log "service=$name state=down"; start "$name" "$script"; sleep 3; proc "$pat" && log "service=$name state=recovered" || log "service=$name state=failed"; }
ensure_http(){ name="$1"; url="$2"; pat="$3"; script="$4"; http "$url" && return; log "service=$name state=unhealthy"; proc "$pat" && pkill -f "$pat" 2>/dev/null || true; start "$name" "$script"; sleep 6; http "$url" && log "service=$name state=recovered probe=http" || log "service=$name state=failed probe=http"; }
log 'event=start result=ok'
while :; do
 ensure_supervisor adb_supervisor '[a]db-recovery-supervisor.sh' "$ROOT/adb-recovery-supervisor.sh"
 ensure_supervisor remote_supervisor '[r]emote-desktop-supervisor.sh' "$ROOT/remote-desktop-supervisor.sh"
 if ! adb_ok; then log 'service=adb state=unhealthy action=delegate_recovery'; fi
 ensure_http gateway http://127.0.0.1:18789/ '[o]penclaw-gateway' "$ROOT/gateway-start.sh"
 ensure_http companion http://127.0.0.1:8765/ 'dist/companion/[s]erver.js' "$ROOT/companion-server.sh"
 sleep 15
done
