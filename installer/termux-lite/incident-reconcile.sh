#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$HOME/ClawMobile/installer/termux-lite"
mkdir -p "$HOME/.openclaw/incidents"
"$ROOT/incident-continuation.py" reconcile >>"$HOME/.openclaw/incidents/reconcile.log" 2>&1
