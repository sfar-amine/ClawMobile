#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"
LOG="$HOME/.openclaw/continuity/boot.log"
log(){ printf '%s boot=continuity %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
log 'event=start'
for n in $(seq 1 24); do
  if adb -s 127.0.0.1:5556 get-state 2>/dev/null | grep -qx device; then
    log "event=adb_ready attempt=$n"
    if "$ROOT/chat-continuity-restore.sh"; then log 'event=restore result=verified'; exit 0; fi
    log 'event=restore result=failed'
  fi
  sleep 10
done
"$ROOT/incident-notify.sh" human_required "Intervention requise — continuité ChatGPT après redémarrage\n\nLa restauration automatique de la conversation exacte n’a pas pu être vérifiée après le démarrage." "1. Déverrouille le S24 si Android demande le code après redémarrage.\n2. Ouvre Termux et laisse-le au premier plan.\n3. Ne modifie aucun autre réglage." || true
log 'event=human_required queued=true'
