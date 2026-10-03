#!/data/data/com.termux/files/usr/bin/bash
set -u
SELF_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
D="$HOME/.openclaw/guardian"; LOG="$D/guardian.log"; mkdir -p "$D" "$HOME/.cache/tmp"; export TMPDIR="$HOME/.cache/tmp"
resolve_runtime_root(){
  control="$HOME/.openclaw/tier0/bin/tier0-control.py"
  if [ -x "$control" ]; then
    root="$("$control" root 9>&- 2>/dev/null || true)"
    [ -n "$root" ] && [ -d "$root" ] && { readlink -f "$root" 9>&-; return; }
  fi
  printf "%s\n" "$SELF_ROOT"
}
refresh_root(){ ROOT="$(resolve_runtime_root)"; }
proc(){ pgrep -f "$1" 9>&- >/dev/null 2>&1; }
process_uses_script(){
  pat="$1"; script="$2"
  for pid in $(pgrep -f "$pat" 9>&- 2>/dev/null); do
    [ -r "/proc/$pid/cmdline" ] || continue
    while IFS= read -r -d '' arg; do
      [ "$arg" = "$script" ] && return 0
    done <"/proc/$pid/cmdline" 2>/dev/null
  done
  return 1
}
stop_supervisor(){ pat="$1"; pkill -TERM -f "$pat" 9>&- 2>/dev/null || true; waited=0; while proc "$pat" && [ "$waited" -lt 8 ]; do sleep 1 9>&-; waited=$((waited+1)); done; if proc "$pat"; then pkill -KILL -f "$pat" 9>&- 2>/dev/null || true; sleep 1 9>&-; fi; }
log(){ printf "%s component=root-guardian %s\n" "$(date -Iseconds)" "$*" >>"$LOG"; }
ensure_supervisor(){
  name="$1"; pat="$2"; script="$3"; stderr="$4"
  if proc "$pat" && process_uses_script "$pat" "$script"; then return 0; fi
  if proc "$pat"; then
    log "event=$name-runtime_drift action=replace expected=$script"
    stop_supervisor "$pat"
  else
    log "event=$name-missing action=start expected=$script"
  fi
  nohup env CLAW_RUNTIME_ROOT="$ROOT" "$script" 9>&- >>"$stderr" 2>&1 </dev/null &
  sleep 2 9>&-
  if proc "$pat" && process_uses_script "$pat" "$script"; then
    log "event=$name-start result=ok runtime_root=$ROOT"
  else
    log "event=$name-start result=failed runtime_root=$ROOT"
  fi
}
refresh_root
exec 9>"$D/guardian.lock"; flock -n 9 || exit 0
log "event=start result=ok runtime_root=$ROOT self_root=$SELF_ROOT"
while :; do
  refresh_root
  printf "%s" "$(date +%s)" >"$HOME/.openclaw/health/root-guardian.heartbeat"
  ensure_supervisor health_manager "[s]amantha-health-manager.sh" "$ROOT/samantha-health-manager.sh" "$D/health-manager.stderr.log"
  ensure_supervisor incident_orchestrator "[i]ncident-orchestrator-worker.sh" "$ROOT/incident-orchestrator-worker.sh" "$D/incident-orchestrator.stderr.log"
  sleep 10 9>&-
done
