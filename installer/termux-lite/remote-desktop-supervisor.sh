#!/data/data/com.termux/files/usr/bin/bash
set -u
HOME_DIR=${HOME:-/data/data/com.termux/files/home}
STATE=$HOME_DIR/.openclaw/watchdogs
LOG=$STATE/remote-desktop-supervisor.log
LOCK=$STATE/remote-desktop-supervisor.lock
CHILD=$HOME_DIR/ClawMobile/installer/termux-lite/remote-desktop-watchdog.sh
mkdir -p "$STATE"
exec 9>"$LOCK"
flock -n 9 || exit 0
log(){ printf '%s component=remote-desktop-supervisor %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
backoff=2
log 'event=start result=ok'
while :; do
  started=$(date +%s)
  log 'event=child_start result=attempt'
  "$CHILD" >>"$STATE/remote-desktop.stderr.log" 2>&1
  rc=$?
  runtime=$(( $(date +%s)-started ))
  log "event=child_exit result=failed rc=$rc runtime_s=$runtime restart_in_s=$backoff"
  if [ "$runtime" -ge 300 ]; then backoff=2; else backoff=$((backoff*2)); [ "$backoff" -gt 60 ] && backoff=60; fi
  sleep "$backoff"
done
