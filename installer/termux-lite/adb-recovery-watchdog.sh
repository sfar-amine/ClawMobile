#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR="/data/data/com.termux/files/home"
STATE_DIR="$HOME_DIR/.openclaw/watchdogs"
LOG="$STATE_DIR/adb-recovery.log"
STATE="$STATE_DIR/adb-recovery.state"
HELP_NOTIFY="$STATE_DIR/adb-help-notified"
LOCK="$STATE_DIR/adb-recovery.lock"
INTERVAL="${ADB_RECOVERY_INTERVAL:-60}"
HELP_AFTER="${ADB_RECOVERY_HELP_AFTER:-3}"
STABLE_PORT="${ADB_RECOVERY_STABLE_PORT:-5556}"
mkdir -p "$STATE_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0
# Do not let long-lived notification/transport descendants inherit the watchdog lock.
exec 9>&-
log(){ printf '%s component=adb-recovery severity=%s event=%s result=%s detail="%s"\n' "$(date -Iseconds)" "$1" "$2" "$3" "$4" >>"$LOG"; }
adb_up(){ adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{found=1} END{exit !found}'; }
wifi_up(){
  # Android may hide /sys/class/net and netlink from Termux. Try several
  # non-invasive signals; a positive result is enough to start recovery.
  [ "$(getprop wlan.driver.status 2>/dev/null)" = ok ] && return 0
  dumpsys wifi 2>/dev/null | grep -Eqi 'Wi-Fi is enabled|mWifiEnabled=true|WIFI_STATE_ENABLED|connected.*ssid|mNetworkInfo.*CONNECTED' && return 0
  # Samsung/Android 16 can hide Wi-Fi state from the Termux UID. Network
  # reachability is sufficient for ADB recovery attempts; it avoids a false
  # waiting_wifi state without claiming which transport provides connectivity.
  timeout 4 ping -c1 1.1.1.1 >/dev/null 2>&1 && return 0
  return 1
}
notify_info(){ "$HOME/ClawMobile/installer/termux-lite/incident-notify.sh" info "$1"; }
notify_help(){ "$HOME/ClawMobile/installer/termux-lite/incident-notify.sh" human_required "$1" "$2"; }

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
      notify_info "Samantha — ADB est de nouveau opérationnel. La récupération automatique est terminée et vérifiée." && rm -f "$HELP_NOTIFY"
      "$HOME_DIR/ClawMobile/installer/termux-lite/chat-continuity-restore.sh" >/dev/null 2>&1 || log WARN continuity_restore failed "deferred ChatGPT restore failed"
    fi
    printf up >"$STATE"; prev=up; recovery_tries=0
  elif ! wifi_up; then
    if [ "$prev" != waiting_wifi ]; then
      log WARN blocked waiting_wifi "ADB unavailable and Wi-Fi required"
      notify_help "Samantha — ADB est bloqué car aucun Wi-Fi exploitable n’est disponible." "1. Ouvre le panneau rapide du S24.\n2. Active le Wi-Fi et connecte-toi à un réseau fonctionnel.\n3. Laisse ensuite le téléphone allumé ; aucune autre action."
    fi
    printf waiting_wifi >"$STATE"; prev=waiting_wifi; recovery_tries=0
  else
    recovery_tries=$((recovery_tries+1))
    log INFO recovery attempt "Wi-Fi available; trying trusted ADB recovery attempt=$recovery_tries"
    if recover_adb; then
      log INFO recovered ok "ADB recovered automatically"
      printf up >"$STATE"; prev=up; recovery_tries=0
      notify_info "Samantha — ADB est de nouveau opérationnel. La récupération automatique est terminée et vérifiée." && rm -f "$HELP_NOTIFY"
      "$HOME_DIR/ClawMobile/installer/termux-lite/chat-continuity-restore.sh" >/dev/null 2>&1 || log WARN continuity_restore failed "deferred ChatGPT restore failed"
    else
      if [ "$prev" != recovery_needed ]; then log WARN recovery pending "trusted automatic ADB recovery did not succeed"; fi
      if [ "$recovery_tries" -ge "$HELP_AFTER" ]; then
        log WARN blocked help_required "ADB recovery requires Wireless Debugging/pairing intervention"
        # help_required remains unacknowledged until WhatsApp delivery succeeds.
        # Retry every watchdog cycle while the prerequisite is still blocked.
        if [ ! -f "$HELP_NOTIFY" ]; then
          if notify_help "Samantha — ADB nécessite une intervention physique après échec de la récupération automatique." "1. Ouvre Paramètres > Options développeur > Débogage sans fil.\n2. Active Débogage sans fil s’il est désactivé ; s’il est déjà actif, ouvre « Associer l’appareil avec un code d’association ».\n3. Laisse cet écran ouvert avec le code et le port visibles ; ne m’envoie pas le code par message."; then
            : >"$HELP_NOTIFY"
            log INFO notify queued "help_required incident queued"
          fi
        fi
      fi
      printf recovery_needed >"$STATE"; prev=recovery_needed
    fi
  fi
  sleep "$INTERVAL"
done
