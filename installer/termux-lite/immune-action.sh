#!/data/data/com.termux/files/usr/bin/bash
# Admission only. Existing owners retain their fixed actions, locks and verifiers.
# Source this file; absence/unavailability of the AI gate always refuses action.
immune_python(){
 local ui="$HOME/.openclaw/runtime-ui-playbooks/current"
 [ -f "$ui/skill_intelligence/immune_intervention.py" ] || return 75
 PYTHONPATH="$ui" python3 -m skill_intelligence.immune_intervention "$@" 9>&-
}
immune_action(){
 local component="$1" operation="$2" grant rc effect_owner_pid="$BASHPID"
 shift 2
 # Caller invokes this boundary only after a fresh failed native observation.
 # A known completed executor may be requalified; an uncertain effect stays held.
 immune_python observe "$component" >/dev/null 2>&1 || true
 grant="$(immune_python allow "$component" "$operation" --effect-owner-pid "$effect_owner_pid")" || return 75
 # The callback is supplied by committed owner code, never by the model.
 if "$@"; then rc=0; else rc=$?; fi
 immune_python settle "$grant" "$rc" >/dev/null || return 75
 return "$rc"
}
immune_observe(){
 local component="$1"; shift
 immune_python observe "$component" "$@" >/dev/null 2>&1 || true
}
