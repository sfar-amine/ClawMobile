#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"
exec "$ROOT/health-verdict.py" "$@"
