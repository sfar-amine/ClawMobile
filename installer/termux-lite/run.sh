#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

REPO_ROOT="$(clawmobile_lite_repo_root)"
PLUGIN_DIR="$REPO_ROOT/openclaw-plugin-mobile-ui"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
GATEWAY_BIND="${GATEWAY_BIND:-loopback}"
OPENCLAW_STATE_ROOT="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_ROOT/openclaw.json}"
PLUGIN_INSTALLED_MANIFEST="$OPENCLAW_STATE_ROOT/extensions/openclaw-plugin-mobile-ui/openclaw.plugin.json"
GATEWAY_PREFLIGHT="$SCRIPT_DIR/gateway-preflight.py"

clawmobile_require_termux
clawmobile_lite_env
clawmobile_require_openclaw
clawmobile_require_npm

cd "$REPO_ROOT"
clawmobile_select_adb_device
clawmobile_build_plugin_lite "$REPO_ROOT"

schema_json="$(python3 "$GATEWAY_PREFLIGHT" plugin-schema   --source-manifest "$PLUGIN_DIR/openclaw.plugin.json"   --installed-manifest "$PLUGIN_INSTALLED_MANIFEST"   --config "$OPENCLAW_CONFIG_FILE")" || {
    echo "[lite] ERROR: plugin/config schema preflight failed: $schema_json" >&2
    exit 1
  }
schema_state="$(printf '%s' "$schema_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')"
if [ "$schema_state" = "repairable" ]; then
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all -- openclaw-plugin-mobile-ui)" ]; then
    echo "[lite] ERROR: installed plugin schema is stale, but source plugin has uncommitted changes; refusing automatic deployment." >&2
    exit 1
  fi
  echo "[lite] Installed plugin schema is stale; reconciling from clean canonical source."
  clawmobile_install_plugin "$PLUGIN_DIR"
elif [ "${CLAWMOBILE_GATEWAY_INSTALL_PLUGIN:-0}" = "1" ]; then
  clawmobile_install_plugin "$PLUGIN_DIR"
else
  echo "[lite] Plugin schema compatible; skipping reinstall."
fi

if ! openclaw config validate </dev/null >/dev/null 2>&1; then
  echo "[lite] ERROR: OpenClaw config validation failed after plugin reconciliation." >&2
  openclaw config validate </dev/null >&2 || true
  exit 1
fi

clawmobile_sync_workspace_seed "$REPO_ROOT"

ensure_gateway_config() {
  local current=""

  current="$(openclaw config get gateway.mode 2>/dev/null || true)"
  if [ "$current" != "local" ]; then
    echo "[lite] Setting OpenClaw gateway.mode=local"
    openclaw config set gateway.mode local </dev/null >/dev/null
  fi

  current="$(openclaw config get gateway.port 2>/dev/null || true)"
  if [ "$current" != "$GATEWAY_PORT" ]; then
    echo "[lite] Setting OpenClaw gateway.port=$GATEWAY_PORT"
    openclaw config set gateway.port "$GATEWAY_PORT" </dev/null >/dev/null
  fi

  current="$(openclaw config get gateway.bind 2>/dev/null || true)"
  if [ "$current" != "$GATEWAY_BIND" ]; then
    echo "[lite] Setting OpenClaw gateway.bind=$GATEWAY_BIND"
    openclaw config set gateway.bind "$GATEWAY_BIND" </dev/null >/dev/null
  fi
}

ensure_gateway_config

if [ "${CLAWMOBILE_TERMUX_REFRESH_DEFAULTS_ON_RUN:-0}" = "1" ]; then
  echo "[lite] Refreshing OpenClaw Termux runtime defaults before gateway start..."
  openclaw config set tools.profile full </dev/null
fi

lock_json="$(python3 "$GATEWAY_PREFLIGHT" stale-locks   --state-dir "$OPENCLAW_STATE_ROOT" --config "$OPENCLAW_CONFIG_FILE"   --port "$GATEWAY_PORT" --apply)" || {
    echo "[lite] ERROR: gateway lock preflight refused recovery: $lock_json" >&2
    exit 1
  }
lock_state="$(printf '%s' "$lock_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')"
if [ "$lock_state" = "recovered" ]; then
  echo "[lite] Recovered an orphaned Android gateway lock; evidence quarantined under OpenClaw backups."
fi

echo "[lite] Starting OpenClaw Gateway in capability-aware Termux runtime mode..."
exec openclaw gateway --bind "$GATEWAY_BIND" --port "$GATEWAY_PORT" --verbose
