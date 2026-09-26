#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
JOB_ID="${1:?job id required}"
ACTION="${2:-run}"
KEY="${3:-}"
BASE="$HOME/.openclaw/workspace/ui-playbooks"
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
