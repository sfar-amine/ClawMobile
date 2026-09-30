#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
UI_ROOT="${SAMANTHA_UI_PLAYBOOKS_ROOT:-$HOME/.openclaw/workspace/ui-playbooks}"
STORE="${SAMANTHA_IMPROVEMENT_STORE:-$HOME/.openclaw/skill-intelligence/improvements.db}"
gate_json="$("$ROOT/learning-gate.py" close "$@")"
learning_text="$(printf '%s' "$gate_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("context_text",""))')"
receipt_id="$(printf '%s' "$gate_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("receipt_id",""))')"
if [ -n "$learning_text" ]; then
  "$ROOT/context-event.sh" openclaw learning "$learning_text" >/dev/null
fi
bridge_json='{"state":"noop","reason":"not_improvement_candidate"}'
if [[ "$learning_text" == IMPROVEMENT_CANDIDATE_V1:* ]] && [ -f "$UI_ROOT/skill_intelligence/improvement.py" ]; then
  set +e
  bridge_json="$(cd "$UI_ROOT" && printf '%s' "$learning_text" | python3 -m skill_intelligence.improvement --store "$STORE" ingest-event --source-id "$receipt_id" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$bridge_json" >&2
    exit "$rc"
  fi
fi
python3 - "$gate_json" "$bridge_json" <<'PY2'
import json,sys
value=json.loads(sys.argv[1]); value["improvement_ingest"]=json.loads(sys.argv[2]); print(json.dumps(value,ensure_ascii=False,separators=(",",":")))
PY2
