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

# Hash-gated local patch only: no build, network or credential mutation.
# Unsupported upgrades remain startable; runtime-sync reports the missing protection.
# A Tier0 release can outlive a checkout rollback. Follow the deployed checkout's
# patch ownership so an old release never reapplies a patch just rolled back.
WA_PATCH_SOURCE="${CLAW_CORE_REPO:-$HOME/ClawMobile}/installer/termux-lite/openclaw-compat/whatsapp-network-recovery.py"
WA_PATCH_MODE=--apply
if [ ! -f "$WA_PATCH_SOURCE" ]; then
  WA_PATCH_SOURCE="$SCRIPT_DIR/openclaw-compat/whatsapp-network-recovery.py"
  WA_PATCH_MODE=--rollback
fi
python3 "$WA_PATCH_SOURCE" "$WA_PATCH_MODE" >&2 ||
  echo "[lite] WARNING: WhatsApp network recovery patch unsupported; runtime drift requires review." >&2

# Follow this patch set's checkout ownership independently of the older WhatsApp set.
AUTH_PATCH_DIR="${CLAW_CORE_REPO:-$HOME/ClawMobile}/installer/termux-lite/openclaw-compat"
AUTH_PATCH_MODE=--apply
if [ ! -f "$AUTH_PATCH_DIR/agent-exec-auth-scope.json" ]; then
  AUTH_PATCH_DIR="$SCRIPT_DIR/openclaw-compat"
  AUTH_PATCH_MODE=--rollback
fi
if [ -f "$AUTH_PATCH_DIR/agent-exec-auth-scope.json" ]; then
  python3 "$AUTH_PATCH_DIR/whatsapp-network-recovery.py" --patch-set agent-exec-auth-scope "$AUTH_PATCH_MODE" >&2 ||
    echo "[lite] WARNING: native auth scope patch unsupported; runtime drift requires review." >&2
fi

# Native ingress provenance follows checkout ownership independently of other patch sets.
NATIVE_PATCH_DIR="${CLAW_CORE_REPO:-$HOME/ClawMobile}/installer/termux-lite/openclaw-compat"
NATIVE_PATCH_MODE=--apply
if [ ! -f "$NATIVE_PATCH_DIR/native-turn-provenance.json" ]; then
  NATIVE_PATCH_DIR="$SCRIPT_DIR/openclaw-compat"
  NATIVE_PATCH_MODE=--rollback
fi
if [ -f "$NATIVE_PATCH_DIR/native-turn-provenance.json" ]; then
  python3 "$NATIVE_PATCH_DIR/whatsapp-network-recovery.py" --patch-set native-turn-provenance "$NATIVE_PATCH_MODE" >&2 ||
    echo "[lite] WARNING: native turn provenance patch unsupported; runtime drift requires review." >&2
fi

echo "[lite] Starting OpenClaw Gateway through fast recovery path..."
exec openclaw gateway --bind "$GATEWAY_BIND" --port "$GATEWAY_PORT" --verbose
