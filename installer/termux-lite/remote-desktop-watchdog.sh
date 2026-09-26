#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR="/data/data/com.termux/files/home"
STATE_DIR="$HOME_DIR/.openclaw/watchdogs"
LOG="$STATE_DIR/remote-desktop.log"
STATE="$STATE_DIR/remote-desktop.state"
LOCK="$STATE_DIR/remote-desktop.lock"
DC="$HOME_DIR/.openclaw-android/bin/node"
DC_SCRIPT="/data/data/com.termux/files/usr/lib/node_modules/@wonderwhy-er/desktop-commander/dist/index.js"
INTERVAL="${REMOTE_DESKTOP_WATCHDOG_INTERVAL:-15}"
MAX_RESTARTS="${REMOTE_DESKTOP_WATCHDOG_MAX_RESTARTS:-2}"
mkdir -p "$STATE_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0
log(){ printf '%s %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
alive(){ pgrep -f '@wonderwhy-er/desktop-commander/dist/index.js remote' >/dev/null 2>&1; }
notify(){
  local msg="$1" target
  target="$(openclaw config get commands.ownerAllowFrom 2>/dev/null | grep -oE '\+?[0-9]{8,15}' | head -1)"
  [ -n "$target" ] || { log "WARN owner WhatsApp target unavailable"; return 1; }
  openclaw message send --channel whatsapp --target "$target" --message "$msg" >/dev/null 2>&1 || log "WARN whatsapp notification failed"
}
restart_dc(){
  local n=1
  while [ "$n" -le "$MAX_RESTARTS" ]; do
    log "restart attempt $n/$MAX_RESTARTS"
    nohup "$DC" "$DC_SCRIPT" remote >>"$STATE_DIR/remote-desktop-process.log" 2>&1 </dev/null &
    sleep 5
    alive && return 0
    n=$((n+1))
  done
  return 1
}
prev="$(cat "$STATE" 2>/dev/null || printf unknown)"
log "watchdog started; previous=$prev"
while :; do
  if alive; then
    if [ "$prev" = down ]; then
      log "RECOVERED"
      notify "Samantha — Remote Desktop Commander est de nouveau opérationnel après l'incident."
    fi
    printf up >"$STATE"; prev=up
  else
    log "DOWN confirmed: Remote Desktop Commander process absent"
    if restart_dc; then
      log "SELF-HEAL SUCCESS"
      printf up >"$STATE"; prev=up
      notify "Samantha — Remote Desktop Commander a crashé. Processus absent détecté ; redémarrage automatique effectué et vérifié avec succès."
    else
      log "SELF-HEAL FAILED"
      if [ "$prev" != down ]; then
        notify "Samantha — Remote Desktop Commander a crashé. J'ai tenté le redémarrage automatique, mais le service reste indisponible. L'incident est journalisé."
      fi
      printf down >"$STATE"; prev=down
    fi
  fi
  sleep "$INTERVAL"
done
