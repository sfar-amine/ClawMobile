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

# OpenClaw cannot prove a lease owner dead once Android hands its PID to another
# app; Doctor then refuses every start. Release only those leases, with a receipt.
lease_json="$(python3 "$GATEWAY_PREFLIGHT" agent-leases --state-dir "$OPENCLAW_STATE_ROOT" --apply)" ||
  echo "[lite] WARNING: agent lease preflight did not complete: $lease_json" >&2
case "$lease_json" in
  *'"state": "recovered"'*) echo "[lite] Released agent database leases held by reused PIDs: $lease_json" ;;
esac

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

# The model profile consumer follows the same checkout/release owner. Never
# silently start a brain-only runtime with an unsupported settings consumer.
MODEL_PATCH_DIR="${CLAW_CORE_REPO:-$HOME/ClawMobile}/installer/termux-lite/openclaw-compat"
MODEL_PATCH_MODE=--apply
if [ ! -f "$MODEL_PATCH_DIR/model-flow-selection.json" ]; then
  MODEL_PATCH_DIR="$SCRIPT_DIR/openclaw-compat"
  MODEL_PATCH_MODE=--rollback
fi
if [ -f "$MODEL_PATCH_DIR/model-flow-selection.json" ]; then
  python3 "$MODEL_PATCH_DIR/whatsapp-network-recovery.py" --patch-set model-flow-selection "$MODEL_PATCH_MODE" >&2 || {
    echo "[lite] ERROR: model profile consumer unsupported; start refused." >&2
    exit 1
  }
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

# The memory recall worker keep-alive follows checkout ownership like the other sets. A refusal only costs latency.
MEMORY_PATCH_DIR="${CLAW_CORE_REPO:-$HOME/ClawMobile}/installer/termux-lite/openclaw-compat"
MEMORY_PATCH_MODE=--apply
if [ ! -f "$MEMORY_PATCH_DIR/memory-retrieval-warm.json" ]; then
  MEMORY_PATCH_DIR="$SCRIPT_DIR/openclaw-compat"
  MEMORY_PATCH_MODE=--rollback
fi
if [ -f "$MEMORY_PATCH_DIR/memory-retrieval-warm.json" ]; then
  python3 "$MEMORY_PATCH_DIR/whatsapp-network-recovery.py" --patch-set memory-retrieval-warm "$MEMORY_PATCH_MODE" >&2 ||
    echo "[lite] WARNING: memory recall keep-alive patch unsupported; runtime drift requires review." >&2
fi

# Android filesystem compatibility (OpenClaw 2026.10+: EACCES copy fallbacks, no /proc/self/ns/pid). Same ownership.
ANDROID_FS_PATCH_DIR="${CLAW_CORE_REPO:-$HOME/ClawMobile}/installer/termux-lite/openclaw-compat"
ANDROID_FS_PATCH_MODE=--apply
if [ ! -f "$ANDROID_FS_PATCH_DIR/android-fs-compat.json" ]; then
  ANDROID_FS_PATCH_DIR="$SCRIPT_DIR/openclaw-compat"
  ANDROID_FS_PATCH_MODE=--rollback
fi
if [ -f "$ANDROID_FS_PATCH_DIR/android-fs-compat.json" ]; then
  python3 "$ANDROID_FS_PATCH_DIR/whatsapp-network-recovery.py" --patch-set android-fs-compat "$ANDROID_FS_PATCH_MODE" >&2 ||
    echo "[lite] WARNING: Android filesystem compatibility patch unsupported; runtime drift requires review." >&2
fi

# Automatic startup triage opt-out (OpenClaw 2026.9.6 and 2026.10.9 run an unsupervised repair agent or
# `claude -p` after a failed Gateway start). Same ownership; the variable is exported only once the
# patched guard is verified, so it never claims a protection the installed modules do not carry.
TRIAGE_PATCH_DIR="${CLAW_CORE_REPO:-$HOME/ClawMobile}/installer/termux-lite/openclaw-compat"
TRIAGE_PATCH_MODE=--apply
if [ ! -f "$TRIAGE_PATCH_DIR/startup-triage-optout.json" ]; then
  TRIAGE_PATCH_DIR="$SCRIPT_DIR/openclaw-compat"
  TRIAGE_PATCH_MODE=--rollback
fi
if [ -f "$TRIAGE_PATCH_DIR/startup-triage-optout.json" ]; then
  python3 "$TRIAGE_PATCH_DIR/whatsapp-network-recovery.py" --patch-set startup-triage-optout "$TRIAGE_PATCH_MODE" >&2 ||
    echo "[lite] WARNING: startup triage opt-out patch unsupported; automatic triage stays as shipped." >&2
  if [ "$TRIAGE_PATCH_MODE" = --apply ] &&
     python3 "$TRIAGE_PATCH_DIR/whatsapp-network-recovery.py" --patch-set startup-triage-optout --check >/dev/null 2>&1; then
    export OPENCLAW_STARTUP_TRIAGE=off
  fi
fi

# Codex hosted web search on Android (OpenClaw 2026.10.9 + @openclaw/codex 2026.10.9). Same ownership. The launcher
# and the explicit search model are exported only once the pinned set is verified, so an unpatched install keeps
# the shipped behaviour instead of a half-configured one.
CODEX_PATCH_DIR="${CLAW_CORE_REPO:-$HOME/ClawMobile}/installer/termux-lite/openclaw-compat"
CODEX_PATCH_MODE=--apply
if [ ! -f "$CODEX_PATCH_DIR/codex-android-compat.json" ]; then
  CODEX_PATCH_DIR="$SCRIPT_DIR/openclaw-compat"
  CODEX_PATCH_MODE=--rollback
fi
if [ -f "$CODEX_PATCH_DIR/codex-android-compat.json" ]; then
  python3 "$CODEX_PATCH_DIR/whatsapp-network-recovery.py" --patch-set codex-android-compat "$CODEX_PATCH_MODE" >&2 ||
    echo "[lite] WARNING: Codex Android compatibility patch unsupported; Codex hosted search stays as shipped." >&2
  if [ "$CODEX_PATCH_MODE" = --apply ] &&
     python3 "$CODEX_PATCH_DIR/whatsapp-network-recovery.py" --patch-set codex-android-compat --check >/dev/null 2>&1; then
    export OPENCLAW_CODEX_APP_SERVER_BIN="$(dirname "$CODEX_PATCH_DIR")/codex-termux.sh"
    # Measured 03/11 on the S24: fastest model that answered correctly (gpt-6-luna was faster but wrong).
    export OPENCLAW_CODEX_WEB_SEARCH_MODEL="${OPENCLAW_CODEX_WEB_SEARCH_MODEL:-gpt-5.6-luna}"
  fi
fi

echo "[lite] Starting OpenClaw Gateway through fast recovery path..."
exec openclaw gateway --bind "$GATEWAY_BIND" --port "$GATEWAY_PORT" --verbose
