#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
gate_json="$("$ROOT/learning-gate.py" close "$@")"
learning_text="$(printf '%s' "$gate_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("context_text",""))')"
if [ -n "$learning_text" ]; then
  "$ROOT/context-event.sh" openclaw learning "$learning_text" >/dev/null
fi
printf '%s\n' "$gate_json"
