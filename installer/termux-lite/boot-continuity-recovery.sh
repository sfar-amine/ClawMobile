#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"
LOG="$HOME/.openclaw/continuity/boot.log"
log(){ printf '%s boot=continuity %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
log "event=start boot_id=$boot_id uptime_s=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo unknown)"
for n in $(seq 1 24); do
  if adb -s 127.0.0.1:5556 get-state 2>/dev/null | grep -qx device; then
    log "event=adb_ready attempt=$n"
    if "$ROOT/chat-continuity-restore.sh"; then log "event=restore result=verified boot_id=$boot_id"; "$ROOT/incident-close.sh" "continuité ChatGPT après redémarrage" "Samantha — continuité ChatGPT restaurée et vérifiée après redémarrage." || true; exit 0; fi
    log 'event=restore result=failed'
  fi
  sleep 10
done
iid=$("$ROOT/incident-orchestrator.py" open adb "boot-$boot_id" --source boot-continuity --summary "post-boot ADB/ChatGPT continuity not verified" 2>/dev/null | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')
"$ROOT/incident-orchestrator.py" observe "$iid" continuity_blocked --source boot-continuity --json "{\"restore_verified\":false}" >/dev/null 2>&1 || true
log "event=escalated orchestrator=true incident_id=$iid boot_id=$boot_id"
