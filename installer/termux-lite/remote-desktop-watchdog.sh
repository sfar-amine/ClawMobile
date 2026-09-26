#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR="/data/data/com.termux/files/home"; STATE_DIR="$HOME_DIR/.openclaw/watchdogs"; LOG="$STATE_DIR/remote-desktop.log"; STATE="$STATE_DIR/remote-desktop.state"; LOCK="$STATE_DIR/remote-desktop.lock"
DC="$HOME_DIR/.openclaw-android/bin/node"; DC_SCRIPT="/data/data/com.termux/files/usr/lib/node_modules/@wonderwhy-er/desktop-commander/dist/index.js"
INTERVAL="${REMOTE_DESKTOP_WATCHDOG_INTERVAL:-15}"; MAX_RESTARTS="${REMOTE_DESKTOP_WATCHDOG_MAX_RESTARTS:-2}"
mkdir -p "$STATE_DIR"; exec 9>"$LOCK"; flock -n 9 || exit 0
log(){ printf '%s %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
alive(){ pgrep -f '@wonderwhy-er/desktop-commander/dist/index.js remote' >/dev/null 2>&1; }
functional(){
  alive || return 1
  f="$STATE_DIR/remote-desktop-process.log"; [ -s "$f" ] || return 1
  # Functional transport evidence: process log must contain a successful Remote MCP
  # connection/device-ready marker, and the log must remain fresh.
  now=$(date +%s); mt=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  [ $((now-mt)) -le 300 ] || return 1
  tail -500 "$f" 2>/dev/null | grep -q 'Connected to Remote MCP' || return 1
  tail -500 "$f" 2>/dev/null | grep -Eq 'Device ready|Connected to Desktop Commander MCP' || return 1
}

notify(){ "$HOME_DIR/ClawMobile/installer/termux-lite/incident-notify.sh" remote_desktop "$1"; }
restart_dc(){ pkill -TERM -f '@wonderwhy-er/desktop-commander/dist/index.js remote' 2>/dev/null || true; sleep 2; n=1; while [ "$n" -le "$MAX_RESTARTS" ]; do log "restart attempt $n/$MAX_RESTARTS"; nohup "$DC" "$DC_SCRIPT" remote >>"$STATE_DIR/remote-desktop-process.log" 2>&1 </dev/null & sleep 8; functional && return 0; n=$((n+1)); done; return 1; }
prev="$(cat "$STATE" 2>/dev/null || printf unknown)"; log "watchdog started; previous=$prev functional_probe=v2"
while :; do
 if functional; then
   if [ "$prev" = down ]; then log "RECOVERED functional=true"; "$HOME_DIR/ClawMobile/installer/termux-lite/incident-close.sh" "Remote Desktop Commander" "Samantha — Remote Desktop Commander est de nouveau opérationnel ; heartbeat fonctionnel vérifié." || true; fi
   printf up >"$STATE"; prev=up
 else
   log "DOWN confirmed: functional heartbeat failed"
   if restart_dc; then log "SELF-HEAL SUCCESS functional=true"; printf up >"$STATE"; prev=up; notify "Samantha — Remote Desktop Commander était non fonctionnel ; redémarrage automatique effectué et heartbeat vérifié."
   else log "SELF-HEAL FAILED"; if [ "$prev" != down ]; then notify "Samantha — Remote Desktop Commander reste indisponible après redémarrage automatique ; la surveillance continue."; fi; printf down >"$STATE"; prev=down; fi
 fi
 sleep "$INTERVAL"
done
