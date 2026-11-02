#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

R="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
D="${SAMANTHA_CONTEXT_ROOT:-$HOME/.openclaw/context-sync}"
# Single code root (02/11): explicit root, then the activated playbooks pin, then the workspace copy (alerted).
UI_ROOT="$(python3 "$R/code_root.py" resolve --component context_dream --require skill_intelligence/improvement.py \
  --override "${SAMANTHA_UI_PLAYBOOKS_ROOT:-}" --override "${CLAW_UI_PLAYBOOKS_ROOT:-}" 2>/dev/null)" \
  || UI_ROOT="${SAMANTHA_UI_PLAYBOOKS_ROOT:-$HOME/.openclaw/workspace/ui-playbooks}"
BRIDGE="${SAMANTHA_IMPROVEMENT_BRIDGE:-1}"
STORE="${SAMANTHA_IMPROVEMENT_STORE:-$HOME/.openclaw/skill-intelligence/improvements.db}"

mkdir -p "$D"
exec 9>"$D/context-dream.lock"
flock -n 9 || exit 0

dream_out="$(python3 "$R/context-dream.py")"
if [[ "$BRIDGE" == "1" && -f "$UI_ROOT/skill_intelligence/improvement.py" ]]; then
  bridge_out="$(
    cd "$UI_ROOT"
    python3 -m skill_intelligence.improvement \
      --store "$STORE" \
      ingest-dream \
      --context-db "$D/memory.db"
  )"
else
  bridge_out='{"state":"noop","reason":"improvement_bridge_disabled_or_unavailable","ingested":0,"deduplicated":0,"errors":[]}'
fi

python3 - "$dream_out" "$bridge_out" <<'PY'
import json
import sys
dream = json.loads(sys.argv[1])
bridge = json.loads(sys.argv[2])
dream["improvementBridge"] = bridge
dream["state"] = "attention_required" if bridge.get("errors") or dream.get("invalidImprovementCount") else ("catch_up_required" if dream.get("morePending") else "healthy")
print(json.dumps(dream, ensure_ascii=False, separators=(",", ":")))
PY
