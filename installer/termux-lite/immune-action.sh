#!/data/data/com.termux/files/usr/bin/bash
# Admission only. Existing owners retain their fixed actions, locks and verifiers.
# Source this file; absence/unavailability of the AI gate always refuses action.
immune_python(){
 local ui="$HOME/.openclaw/runtime-ui-playbooks/current"
 [ -f "$ui/skill_intelligence/immune_intervention.py" ] || return 75
 PYTHONPATH="$ui" python3 -m skill_intelligence.immune_intervention "$@" 9>&-
}
immune_action(){
 local component="$1" operation="$2" grant rc effect_owner_pid="$BASHPID" observation="${IMMUNE_OBSERVATION:-}"
 local allow=(allow "$component" "$operation" --effect-owner-pid "$effect_owner_pid")
 shift 2
 # Caller invokes this boundary only after a fresh failed native observation.
 # A known completed executor may be requalified; an uncertain effect stays held.
 # IMMUNE_OBSERVATION carries the caller's own probe facts: without them the
 # model only reads "a health check failed" and answers "undetermined" (S24 26/10).
 [ -n "$observation" ] && allow+=(--observation "$observation")
 immune_python observe "$component" >/dev/null 2>&1 || true
 grant="$(immune_python "${allow[@]}")" || return 75
 # The callback is supplied by committed owner code, never by the model.
 if "$@"; then rc=0; else rc=$?; fi
 immune_python settle "$grant" "$rc" >/dev/null || return 75
 return "$rc"
}
immune_observe(){
 local component="$1"; shift
 immune_python observe "$component" "$@" >/dev/null 2>&1 || true
}
# Native facts for a missing or drifted supervisor, read by the caller's probe.
immune_supervisor_facts(){
 local name="$1" pat="$2" script="$3" pids
 pids="$(pgrep -f "$pat" 9>&- 2>/dev/null | tr '\n' ' ')"
 if [ -z "$pids" ]; then
  printf '%s supervisor is not running: no process matches %s. Expected script: %s (current release). The bounded operation starts only this supervisor under the existing restart budget and lock, then verifies the process on the current release.' "$name" "$pat" "$script"
 else
  printf '%s supervisor is running from another release (pids %s) instead of %s. The bounded operation replaces only this supervisor on the current release, then verifies the process.' "$name" "${pids% }" "$script"
 fi
}
