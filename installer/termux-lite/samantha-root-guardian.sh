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
ensure_supervisor_effect(){
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
# The AI gate reaches its models only through the Companion (/v1/intent/interpret), which
# only the health manager starts. With the Companion down the gate can never answer: after a
# reboot nothing came back by itself and every refusal was silent (S24 27/10). The Gateway
# alone is not enough: at 22:27 it answered while the Companion was gone and every model call
# of the gate came back unavailable.
gate_reachable(){ timeout 3 curl -fsS "http://127.0.0.1:${CLAWMOBILE_COMPANION_PORT:-8765}/" 9>&- >/dev/null 2>&1; }
DIRECT_START_MIN_S=60
direct_start_due(){
  local f="$D/$1.direct-start" now last
  now=$(date +%s); last=$(cat "$f" 2>/dev/null) || last=0
  [ $((now-${last:-0})) -ge "$DIRECT_START_MIN_S" ] || return 1
  printf '%s' "$now" >"$f"
}
declare -A REFUSAL_LOGGED=()
# Tier0 promotion of the release this guardian runs from: the owner's deploy has already
# selected and verified it, and tier0 only starts its soak once these very supervisors
# report healthy from it (120 s window). Bringing them up is the promotion, not an
# incident to propose to the AI gate, whose model answers through the Gateway that
# the deploy is restarting. S24 01/11 22:29 and 22:36 (OpenClaw 2026.10.9): the gate
# refused, the orchestrator came up 3 s then 13 s after the window, and both the
# deploy and its rollback ended activation_readiness_failed.
tier0_activation_active(){
  python3 - "$HOME/.openclaw/tier0/state.json" "$ROOT" 9>&- 2>/dev/null <<'PY_ACTIVATION'
import json, os, sys, time
try:
    s = json.load(open(sys.argv[1]))
    root = os.path.realpath(sys.argv[2])
    deadline = s.get("activation_deadline_epoch")
    ok = (s.get("soak_state") == "activating" and isinstance(s.get("current"), str)
          and isinstance(deadline, (int, float)) and time.time() < deadline
          and os.path.basename(root) == "termux-lite"
          and os.path.basename(os.path.dirname(root)) == s["current"])
except Exception:
    ok = False
sys.exit(0 if ok else 1)
PY_ACTIVATION
}
# A healthy sample never calls a model. A missing/drifting supervisor is a
# proposal to the existing engineering AI owner, not restart authority; only a
# missing one is started directly, and only while the gate itself is unreachable,
# except during the tier0 activation of this guardian's own release (above).
ensure_supervisor(){
  local name="$1" pat="$2" script="$3"
  if proc "$pat" && process_uses_script "$pat" "$script"; then
    REFUSAL_LOGGED[$name]=; immune_observe "$name" --healthy; return 0
  fi
  if tier0_activation_active; then
    log "event=$name-restore action=activation_start reason=tier0_activation"
    ensure_supervisor_effect "$@"; REFUSAL_LOGGED[$name]=; return 0
  fi
  if IMMUNE_OBSERVATION="$(immune_supervisor_facts "$name" "$pat" "$script" 2>/dev/null)" immune_action "$name" bounded-supervisor-restore ensure_supervisor_effect "$@"; then
    REFUSAL_LOGGED[$name]=; return 0
  fi
  if ! proc "$pat" && ! gate_reachable; then
    direct_start_due "$name" || return 0
    log "event=$name-missing action=direct_start reason=ai_gate_unreachable"
    ensure_supervisor_effect "$@"; REFUSAL_LOGGED[$name]=; return 0
  fi
  [ -n "${REFUSAL_LOGGED[$name]:-}" ] || log "event=$name-restore action=wait reason=ai_gate_refused"
  REFUSAL_LOGGED[$name]=1
}
refresh_root
if [ -f "$ROOT/immune-action.sh" ]; then . "$ROOT/immune-action.sh"; else
  immune_action(){ return 75; }; immune_observe(){ :; }
fi
exec 9>"$D/guardian.lock"; flock -n 9 || exit 0
log "event=start result=ok runtime_root=$ROOT self_root=$SELF_ROOT"
while :; do
  refresh_root
  printf "%s" "$(date +%s)" >"$HOME/.openclaw/health/root-guardian.heartbeat"
  ensure_supervisor tier0_watchdog "[t]ier0-watchdog.py" "$HOME/.openclaw/tier0/bin/tier0-watchdog.py" "$HOME/.openclaw/tier0/watchdog.stderr.log"
  ensure_supervisor health_manager "[s]amantha-health-manager.sh" "$ROOT/samantha-health-manager.sh" "$D/health-manager.stderr.log"
  ensure_supervisor incident_orchestrator "[i]ncident-orchestrator-worker.sh" "$ROOT/incident-orchestrator-worker.sh" "$D/incident-orchestrator.stderr.log"
  sleep 10 9>&-
done
