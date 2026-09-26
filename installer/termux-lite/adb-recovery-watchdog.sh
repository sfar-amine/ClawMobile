#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR="/data/data/com.termux/files/home"
STATE_DIR="$HOME_DIR/.openclaw/watchdogs"
LOG="$STATE_DIR/adb-recovery.log"
STATE="$STATE_DIR/adb-recovery.state"
LOCK="$STATE_DIR/adb-recovery.lock"
INTERVAL="${ADB_RECOVERY_INTERVAL:-60}"
HELP_AFTER="${ADB_RECOVERY_HELP_AFTER:-3}"
mkdir -p "$STATE_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0
log(){ printf '%s component=adb-recovery severity=%s event=%s result=%s detail="%s"\n' "$(date -Iseconds)" "$1" "$2" "$3" "$4" >>"$LOG"; }
adb_up(){ adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{found=1} END{exit !found}'; }
wifi_up(){ [ -d /sys/class/net/wlan0 ] && grep -q '^1$' /sys/class/net/wlan0/carrier 2>/dev/null; }
notify(){
  local msg="$1" target
  target="$(openclaw config get commands.ownerAllowFrom 2>/dev/null | grep -oE '\+?[0-9]{8,15}' | head -1)"
  [ -n "$target" ] || { log WARN notify skipped "owner WhatsApp target unavailable"; return 1; }
  openclaw message send --channel whatsapp --target "$target" --message "$msg" >/dev/null 2>&1 || { log WARN notify failed "WhatsApp notification failed"; return 1; }
}
prev="$(cat "$STATE" 2>/dev/null || printf unknown)"
recovery_tries=0
log INFO start ok "watchdog started previous=$prev"
while :; do
  if adb_up; then
    if [ "$prev" != up ]; then
      log INFO recovered ok "ADB operational"
      notify "Samantha — ADB est de nouveau opérationnel. La récupération automatique est terminée et vérifiée."
    fi
    printf up >"$STATE"; prev=up; recovery_tries=0
  elif ! wifi_up; then
    if [ "$prev" != waiting_wifi ]; then
      log WARN blocked waiting_wifi "ADB unavailable and Wi-Fi required"
      notify "Samantha — J'ai besoin de ton aide pour rétablir ADB : aucun Wi-Fi exploitable n'est disponible. Connecte le téléphone à un Wi-Fi ; je reprendrai automatiquement dès qu'il sera disponible et je t'enverrai l'état final."
    fi
    printf waiting_wifi >"$STATE"; prev=waiting_wifi; recovery_tries=0
  else
    recovery_tries=$((recovery_tries+1))
    if [ "$prev" != recovery_needed ]; then
      log WARN recovery pending "ADB unavailable; Wi-Fi present; automated recovery stage required"
    fi
    if [ "$recovery_tries" -eq "$HELP_AFTER" ]; then
      log WARN blocked help_required "ADB recovery still blocked after Wi-Fi became available"
      notify "Samantha — J'ai encore besoin de ton aide pour rétablir ADB malgré le Wi-Fi disponible. La récupération automatique reste bloquée. Je continue à surveiller et je reprendrai automatiquement après ton intervention ; je te confirmerai sur WhatsApp dès que tout sera rétabli."
    fi
    printf recovery_needed >"$STATE"; prev=recovery_needed
  fi
  sleep "$INTERVAL"
done
