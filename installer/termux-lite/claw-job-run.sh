#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
JOB_ID="${1:?job id required}"
ACTION="${2:-run}"
KEY="${3:-}"
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# Single code root (02/11): the activated playbooks pin first; the workspace copy only as an alerted fallback.
BASE="$(python3 "$HERE/code_root.py" resolve --component claw_job_run --require scheduling/runner.py \
  --override "${CLAW_UI_PLAYBOOKS_ROOT:-}" 2>/dev/null)" || BASE="$HOME/.openclaw/workspace/ui-playbooks"
cd "$BASE"
args=("$JOB_ID" "--idempotency-key" "$KEY")
if [[ "$ACTION" == "prestart" ]]; then
  args+=("--prestart" "--scheduled-at" "2026-09-28 10:00 Africa/Tunis")
fi
if [[ "${CLAW_JOB_DRY_NOTIFICATIONS:-0}" == "1" ]]; then
  args+=("--dry-notifications")
fi
if [[ -n "${CLAW_JOB_MODE:-}" ]]; then
  args+=("--mode" "$CLAW_JOB_MODE")
fi
exec python scheduling/runner.py "${args[@]}"
