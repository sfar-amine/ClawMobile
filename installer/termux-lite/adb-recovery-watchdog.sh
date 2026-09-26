#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR="/data/data/com.termux/files/home"
STATE_DIR="$HOME_DIR/.openclaw/watchdogs"
LOG="$STATE_DIR/adb-recovery.log"
STATE="$STATE_DIR/adb-recovery.state"
LOCK="$STATE_DIR/adb-recovery.lock"
INTERVAL="${ADB_RECOVERY_INTERVAL:-60}"
HELP_AFTER="${ADB_RECOVERY_HELP_AFTER:-3}"
STABLE_PORT="${ADB_RECOVERY_STABLE_PORT:-5555}"
mkdir -p "$STATE_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0
log(){ printf '%s component=adb-recovery severity=%s event=%s result=%s detail="%s"\n' "$(date -Iseconds)" "$1" "$2" "$3" "$4" >>"$LOG"; }
adb_up(){ adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{found=1} END{exit !found}'; }
wifi_up(){
  # Android may hide /sys/class/net and netlink from Termux. Try several
  # non-invasive signals; a positive result is enough to start recovery.
  [ "$(getprop wlan.driver.status 2>/dev/null)" = ok ] && return 0
  dumpsys wifi 2>/dev/null | grep -Eqi 'Wi-Fi is enabled|mWifiEnabled=true|WIFI_STATE_ENABLED|connected.*ssid|mNetworkInfo.*CONNECTED' && return 0
  return 1
}
notify(){
  local msg="$1" target
  target="$(openclaw config get commands.ownerAllowFrom 2>/dev/null | grep -oE '\+?[0-9]{8,15}' | head -1)"
  [ -n "$target" ] || { log WARN notify skipped "owner WhatsApp target unavailable"; return 1; }
  timeout 20 openclaw message send --channel whatsapp --target "$target" --message "$msg" >/dev/null 2>&1 || { log WARN notify failed "WhatsApp notification failed"; return 1; }
}
recover_adb(){
  adb start-server >/dev/null 2>&1 || true
  adb connect "127.0.0.1:$STABLE_PORT" >/dev/null 2>&1 || true
  adb_up && return 0

  # If a previously trusted dynamic Wireless Debugging endpoint was recorded,
  # retry it. Never manufacture an endpoint or pairing credential.
  if [ -s "$STATE_DIR/adb-last-endpoint" ]; then
    ep="$(cat "$STATE_DIR/adb-last-endpoint" 2>/dev/null)"
    case "$ep" in
      127.0.0.1:[0-9]*|localhost:[0-9]*)
        adb connect "$ep" >/dev/null 2>&1 || true
        if adb_up; then
          adb tcpip "$STABLE_PORT" >/dev/null 2>&1 || true
          sleep 2
          adb connect "127.0.0.1:$STABLE_PORT" >/dev/null 2>&1 || true
          adb_up && return 0
        fi
        ;;
    esac
  fi
  return 1
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
    log INFO recovery attempt "Wi-Fi available; trying trusted ADB recovery attempt=$recovery_tries"
    if recover_adb; then
      log INFO recovered ok "ADB recovered automatically"
      printf up >"$STATE"; prev=up; recovery_tries=0
      notify "Samantha — ADB est de nouveau opérationnel. La récupération automatique est terminée et vérifiée."
    else
      if [ "$prev" != recovery_needed ]; then log WARN recovery pending "trusted automatic ADB recovery did not succeed"; fi
      if [ "$recovery_tries" -eq "$HELP_AFTER" ]; then
        log WARN blocked help_required "ADB recovery requires Wireless Debugging/pairing intervention"
        notify "Samantha — Le Wi-Fi est disponible, mais ADB ne s'est pas reconnecté avec la confiance existante. J'ai besoin que tu ouvres Paramètres > Options développeur > Débogage sans fil et que tu laisses cet écran ouvert. Je continue à surveiller et je te confirmerai dès qu'ADB sera rétabli."
      fi
      printf recovery_needed >"$STATE"; prev=recovery_needed
    fi
  fi
  sleep "$INTERVAL"
done
