#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
mkdir -p "$HOME/bin" "$HOME/.openclaw/remote-bridge"
install -m 700 "$ROOT/claw-route.py" "$HOME/bin/claw-route"
ln -sfn "$HOME/bin/claw-route" "$PREFIX/bin/claw-route"
install -m 600 "$ROOT/claw-route-policy.json" "$HOME/.openclaw/remote-bridge/route-policy.json"
claw-route status
