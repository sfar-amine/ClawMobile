#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
cd "$HOME/.openclaw/workspace/ui-playbooks"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH=.
exec python3 -m skill_intelligence.repair_runtime "$@"
