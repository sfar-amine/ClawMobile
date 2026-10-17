#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
mkdir -p "$HOME/.openclaw/incidents"
"$ROOT/incident-continuation.py" reconcile >>"$HOME/.openclaw/incidents/reconcile.log" 2>&1
