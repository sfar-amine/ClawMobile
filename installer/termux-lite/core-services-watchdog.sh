#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"; D="$HOME/.openclaw/watchdogs"; LOG="$D/core-services.log"
mkdir -p "$D"; exec 9>"$D/core-services.lock"; flock -n 9 || exit 0; exec 9>&-
log(){ printf '%s component=core-services %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
alive_gw(){ pgrep -f 'openclaw-gateway' >/dev/null; }
alive_cp(){ pgrep -f 'dist/companion/server.js' >/dev/null; }
heal(){ n="$1"; f="$2"; if ! "alive_$n"; then log "event=down service=$n"; nohup "$f" >>"$D/$n-process.log" 2>&1 </dev/null & sleep 5; if "alive_$n"; then log "event=recovered service=$n"; "$ROOT/incident-notify.sh" core_service "Samantha — service $n récupéré automatiquement." >/dev/null 2>&1 & else log "event=recovery_failed service=$n"; "$ROOT/incident-notify.sh" human_required "Samantha — service $n indisponible après tentative de récupération automatique." >/dev/null 2>&1 & fi; fi; }
log 'event=start result=ok'
while :; do heal gw "$ROOT/gateway-start.sh"; heal cp "$ROOT/companion-server.sh"; sleep 20; done
