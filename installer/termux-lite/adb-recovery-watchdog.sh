#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR="/data/data/com.termux/files/home"
STATE_DIR="$HOME_DIR/.openclaw/watchdogs"
LOG="$STATE_DIR/adb-recovery.log"
STATE="$STATE_DIR/adb-recovery.state"
LOCK="$STATE_DIR/adb-recovery.lock"
INTERVAL="${ADB_RECOVERY_INTERVAL:-60}"
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
log INFO start ok "watchdog started previous=$prev"
while :; do
  if adb_up; then
    if [ "$prev" != up ]; then
      log INFO recovered ok "ADB operational"
      notify "Samantha — ADB est de nouveau opérationnel. La récupération automatique est terminée et vérifiée."
    fi
    printf up >"$STATE"; prev=up
  elif ! wifi_up; then
    if [ "$prev" != waiting_wifi ]; then
      log WARN blocked waiting_wifi "ADB unavailable and Wi-Fi required"
      notify "Samantha — J'ai besoin de ton aide pour rétablir ADB : aucun Wi-Fi exploitable n'est disponible. Connecte le téléphone à un Wi-Fi ; je reprendrai automatiquement dès qu'il sera disponible et je t'enverrai l'état final."
    fi
    printf waiting_wifi >"$STATE"; prev=waiting_wifi
  else
    if [ "$prev" != recovery_needed ]; then
      log WARN recovery pending "ADB unavailable; Wi-Fi present; automated UI pairing/reconnect stage required"
      notify "Samantha — ADB est indisponible mais le Wi-Fi est présent. Je poursuis automatiquement la récupération ; je te préviendrai si une intervention reste nécessaire."
    fi
    printf recovery_needed >"$STATE"; prev=recovery_needed
  fi
  sleep "$INTERVAL"
done
