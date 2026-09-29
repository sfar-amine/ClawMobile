#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"; D="$HOME/.openclaw/guardian"; LOG="$D/guardian.log"; mkdir -p "$D" "$HOME/.cache/tmp"; export TMPDIR="$HOME/.cache/tmp"
exec 9>"$D/guardian.lock"; flock -n 9 || exit 0
log(){ printf '%s component=root-guardian %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
log 'event=start result=ok'
while :; do
  printf '%s' "$(date +%s)" >"$HOME/.openclaw/health/root-guardian.heartbeat"
  if ! pgrep -f '[s]amantha-health-manager.sh' >/dev/null; then
    log 'event=health_manager_missing action=start'
    nohup "$ROOT/samantha-health-manager.sh" 9>&- >>"$D/health-manager.stderr.log" 2>&1 </dev/null &
    sleep 3
    pgrep -f '[s]amantha-health-manager.sh' >/dev/null && log 'event=health_manager_start result=ok' || log 'event=health_manager_start result=failed'
  fi
  if ! pgrep -f '[i]ncident-orchestrator-worker.sh' >/dev/null; then
    log 'event=incident_orchestrator_missing action=start'
    nohup "$ROOT/incident-orchestrator-worker.sh" 9>&- >>"$D/incident-orchestrator.stderr.log" 2>&1 </dev/null &
  fi
  sleep 10
done
