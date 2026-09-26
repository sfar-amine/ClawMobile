#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"; D="$HOME/.openclaw/health"; LOG="$D/health.log"; mkdir -p "$D"; export TMPDIR="$HOME/.cache/tmp"
exec 9>"$D/health.lock"; flock -n 9 || exit 0; exec 9>&-
log(){ printf '%s component=health-manager %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
ensure(){ pat="$1"; script="$2"; name="$3"; if pgrep -f "$pat" >/dev/null; then return 0; fi; log "service=$name state=down action=start"; nohup "$script" >>"$D/$name.stderr.log" 2>&1 </dev/null & sleep 3; pgrep -f "$pat" >/dev/null && log "service=$name state=recovered" || log "service=$name state=failed"; }
log 'event=start result=ok'
while :; do
 ensure '[a]db-recovery-supervisor.sh' "$ROOT/adb-recovery-supervisor.sh" adb
 ensure '[r]emote-desktop-supervisor.sh' "$ROOT/remote-desktop-supervisor.sh" remote
 ensure '[o]penclaw-gateway' "$ROOT/gateway-start.sh" gateway
 ensure 'dist/companion/[s]erver.js' "$ROOT/companion-server.sh" companion
 sleep 15
done
