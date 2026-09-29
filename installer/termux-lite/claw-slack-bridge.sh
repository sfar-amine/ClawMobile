#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/lib.sh"

clawmobile_require_termux
clawmobile_lite_env

NODE="$HOME/.openclaw-android/bin/node"
SCRIPT="$ROOT/claw-slack-bridge.mjs"
STATE_DIR="$HOME/.openclaw/remote-bridge/slack"

mkdir -p "$STATE_DIR"
chmod 700 "$HOME/.openclaw/remote-bridge" "$STATE_DIR" 2>/dev/null || true

exec "$NODE" "$SCRIPT"
