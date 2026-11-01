#!/data/data/com.termux/files/usr/bin/bash
# OpenClaw runtime upgrade 2026.9.6 -> 2026.10.9 with automatic rollback (owner: openclaw-upgrade.py).
# Same lock, receipts directory and preflight thresholds as companion-deploy.sh; see the module docstring.
#   openclaw-upgrade.sh --profile prod --detach         the production switch (detached: the Companion restart
#                                                       drops the Claw link; poll the receipt)
#   openclaw-upgrade.sh --profile staging [...]         rehearsal on ~/.openclaw-android/staging/upgrade-rehearsal
#   openclaw-upgrade.sh --profile prod --dry-run        preflight only, nothing stopped or changed
#   openclaw-upgrade.sh --profile prod --status         last receipt
set -uo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
unset SAMANTHA_DEPLOY_LOCK_FD
if [ "${1:-}" = "--detach" ] || [ "${3:-}" = "--detach" ]; then
  args=(); for a in "$@"; do [ "$a" = "--detach" ] || args+=("$a"); done
  stamp="$(date +%Y%m%dT%H%M%S)"
  setsid nohup python3 "$HERE/openclaw-upgrade.py" --stamp "$stamp" "${args[@]}" >/dev/null 2>&1 </dev/null 9>&- &
  echo "detached stamp=$stamp receipt=openclaw-upgrade-$stamp.json"
  exit 0
fi
exec python3 "$HERE/openclaw-upgrade.py" "$@" 9>&-
