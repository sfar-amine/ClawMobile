#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR="/data/data/com.termux/files/home"; STATE_DIR="$HOME_DIR/.openclaw/watchdogs"; LOG="$STATE_DIR/remote-desktop.log"; STATE="$STATE_DIR/remote-desktop.state"; LOCK="$STATE_DIR/remote-desktop.lock"
DC="$HOME_DIR/.openclaw-android/bin/node"; DC_SCRIPT="/data/data/com.termux/files/usr/lib/node_modules/@wonderwhy-er/desktop-commander/dist/index.js"
INTERVAL="${REMOTE_DESKTOP_WATCHDOG_INTERVAL:-15}"; MAX_RESTARTS="${REMOTE_DESKTOP_WATCHDOG_MAX_RESTARTS:-2}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ORCH="$SCRIPT_DIR/incident-orchestrator.py"; NOTIFY="$SCRIPT_DIR/incident-notify.sh"; CLOSE_NOTIFY="$SCRIPT_DIR/incident-close.sh"
cd "$HOME_DIR" || exit 70
mkdir -p "$STATE_DIR"; exec 9>"$LOCK"; flock -n 9 || exit 0
log(){ printf '%s %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
alive(){ pgrep -f '@wonderwhy-er/desktop-commander/dist/index.js remote' >/dev/null 2>&1; }
functional(){ alive; }
ready_since(){
  off="$1"; f="$STATE_DIR/remote-desktop-process.log"; [ -s "$f" ] || return 1
  tail -c +$((off+1)) "$f" 2>/dev/null | grep -q '^[[:space:]]*- 🔌 Connected to Remote MCP' || return 1
  tail -c +$((off+1)) "$f" 2>/dev/null | grep -Eq '^[[:space:]]*(✅ Device ready:|- 🔌 Connected to Desktop Commander MCP)' || return 1
}

notify(){ "$NOTIFY" remote_desktop "$1"; }
open_incident(){ "$ORCH" open remote_desktop runtime --source remote-desktop-watchdog --summary "$1" >/dev/null 2>&1 || true; }
recover_incident(){ "$ORCH" recover remote_desktop runtime --source remote-desktop-watchdog --reason "$1" >/dev/null 2>&1 || true; }
trim_process_log(){
  f="$STATE_DIR/remote-desktop-process.log"; [ -f "$f" ] || return 0
  size=$(wc -c <"$f" 2>/dev/null || echo 0)
  if [ "$size" -gt 4194304 ]; then tail -c 1048576 "$f" >"$f.tmp" && mv "$f.tmp" "$f"; fi
}
restart_dc(){
  cd "$HOME_DIR" || return 1
  pkill -TERM -f '@wonderwhy-er/desktop-commander/dist/index.js remote' 2>/dev/null || true; sleep 2 9>&-
  trim_process_log
  n=1
  while [ "$n" -le "$MAX_RESTARTS" ]; do
    f="$STATE_DIR/remote-desktop-process.log"; before=$(wc -c <"$f" 2>/dev/null || echo 0)
    log "restart attempt $n/$MAX_RESTARTS"
    nohup "$DC" "$DC_SCRIPT" remote 9>&- >>"$f" 2>&1 </dev/null & sleep 8 9>&-
    alive && ready_since "$before" && return 0
    n=$((n+1))
  done
  return 1
}
prev="$(cat "$STATE" 2>/dev/null || printf unknown)"; log "watchdog started; previous=$prev functional_probe=v3_process_steady_startup_transport"
while :; do
 printf '%s' "$(date +%s)" >"$HOME_DIR/.openclaw/health/remote-watchdog.heartbeat"
 if functional; then
   if [ "$prev" = down ]; then
     log "RECOVERED functional=true circuit=closed"
     recover_incident "Desktop Commander functional recovery verified"
     "$CLOSE_NOTIFY" "Remote Desktop Commander" "Samantha — Remote Desktop Commander est de nouveau opérationnel ; heartbeat fonctionnel vérifié." || true
   fi
   printf up >"$STATE"; prev=up
 else
   if [ "$prev" = down ]; then
     sleep "$INTERVAL" 9>&-
     continue
   fi
   log "DOWN confirmed: functional heartbeat failed"
   if restart_dc; then
     log "SELF-HEAL SUCCESS functional=true"
     printf up >"$STATE"; prev=up
     notify "Samantha — Remote Desktop Commander était non fonctionnel ; redémarrage automatique effectué et heartbeat vérifié."
   else
     log "SELF-HEAL FAILED circuit=open"
     open_incident "Remote Desktop Commander unavailable after $MAX_RESTARTS bounded deterministic restart attempts"
     notify "Samantha — Remote Desktop Commander reste indisponible après redémarrage automatique ; circuit ouvert et diagnostic géré déclenché."
     printf down >"$STATE"; prev=down
   fi
 fi
 sleep "$INTERVAL" 9>&-
done
