#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

GATEWAY_PORT="${GATEWAY_PORT:-${CLAWMOBILE_GATEWAY_PORT:-18789}}"
GATEWAY_BIND="${GATEWAY_BIND:-loopback}"
OPENCLAW_STATE_ROOT="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_ROOT/openclaw.json}"
GATEWAY_PREFLIGHT="$SCRIPT_DIR/gateway-preflight.py"

clawmobile_require_termux
clawmobile_lite_env
clawmobile_require_openclaw

# Recovery must remain light. Full plugin/build/workspace reconciliation belongs
# to run.sh/install flows; replaying it here can exceed Companion's bounded
# recovery window and leave the Gateway down after a safe restart.
lock_json="$(python3 "$GATEWAY_PREFLIGHT" stale-locks   --state-dir "$OPENCLAW_STATE_ROOT"   --config "$OPENCLAW_CONFIG_FILE"   --port "$GATEWAY_PORT"   --apply)" || {
    echo "[lite] ERROR: gateway lock preflight refused recovery: $lock_json" >&2
    exit 1
  }
lock_state="$(printf '%s' "$lock_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')"
if [ "$lock_state" = "recovered" ]; then
  echo "[lite] Recovered an orphaned Android gateway lock; evidence quarantined under OpenClaw backups."
fi

echo "[lite] Starting OpenClaw Gateway through fast recovery path..."
exec openclaw gateway --bind "$GATEWAY_BIND" --port "$GATEWAY_PORT" --verbose
