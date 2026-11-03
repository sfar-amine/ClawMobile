#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

REPO_ROOT="$(clawmobile_lite_repo_root)"
PLUGIN_DIR="$REPO_ROOT/openclaw-plugin-mobile-ui"

CLAWMOBILE_COMPANION_HOST="${CLAWMOBILE_COMPANION_HOST:-}"
CLAWMOBILE_COMPANION_PORT="${CLAWMOBILE_COMPANION_PORT:-8765}"
CLAWMOBILE_GATEWAY_HOST="${CLAWMOBILE_GATEWAY_HOST:-127.0.0.1}"
CLAWMOBILE_GATEWAY_PORT="${CLAWMOBILE_GATEWAY_PORT:-${GATEWAY_PORT:-18789}}"
CLAWMOBILE_RUNTIME_START_COMMAND="$(clawmobile_runtime_start_command "$SCRIPT_DIR")"
# The deploy that starts the Companion exports its lock descriptor; the Companion outlives that deploy, so every
# later bridge command inherited a dead SAMANTHA_DEPLOY_LOCK_FD=9 and Tier0 promote failed on EBADF (S24 18/10 01:25).
unset SAMANTHA_DEPLOY_LOCK_FD
CLAWMOBILE_RUNTIME_START_ARGS="${CLAWMOBILE_RUNTIME_START_ARGS:-}"
SAMANTHA_CONTROL_CACHE="${SAMANTHA_CONTROL_CACHE:-1}"

export CLAWMOBILE_COMPANION_HOST
export CLAWMOBILE_COMPANION_PORT
export CLAWMOBILE_GATEWAY_HOST
export CLAWMOBILE_GATEWAY_PORT
export CLAWMOBILE_RUNTIME_START_COMMAND
export CLAWMOBILE_RUNTIME_START_ARGS
export SAMANTHA_CONTROL_CACHE

clawmobile_require_termux
clawmobile_lite_env
clawmobile_require_openclaw
clawmobile_require_npm

cd "$REPO_ROOT"
clawmobile_select_adb_device
# Single code root (02/11): rebuild and re-seed only from the deployed commit. Otherwise keep starting on the
# dist already built by the last deploy, and leave a code-root event (alerted by runtime-sync.sh --check).
code_root_event() { python3 "$SCRIPT_DIR/code_root.py" event --component "$1" --event "$2" --reason "$3" --root "$REPO_ROOT" >/dev/null 2>&1 || true; }
CODE_ROOT_STATE="$(clawmobile_code_root_state "$REPO_ROOT")"
if [ "$CODE_ROOT_STATE" = ok ]; then
  clawmobile_build_plugin_lite "$REPO_ROOT"
elif [ ! -f "$PLUGIN_DIR/dist/companion/server.js" ]; then
  echo "[lite] WARNING: checkout state $CODE_ROOT_STATE and no built Companion; building anyway so the Companion starts." >&2
  code_root_event companion_build built_unverified "$CODE_ROOT_STATE"
  clawmobile_build_plugin_lite "$REPO_ROOT"
else
  echo "[lite] WARNING: checkout state $CODE_ROOT_STATE; keeping the deployed Companion build (no plugin rebuild)." >&2
  code_root_event companion_build skipped "$CODE_ROOT_STATE"
fi
if [ "${CLAWMOBILE_COMPANION_INSTALL_PLUGIN:-0}" = "1" ]; then
  clawmobile_install_plugin "$PLUGIN_DIR"
else
  echo "[lite] Skipping OpenClaw plugin reinstall during companion server startup."
  echo "[lite] Run 'clawmobile install' or set CLAWMOBILE_COMPANION_INSTALL_PLUGIN=1 to refresh plugin registration."
fi
if [ "$CODE_ROOT_STATE" = ok ]; then
  clawmobile_sync_workspace_seed "$REPO_ROOT"
else
  echo "[lite] WARNING: checkout state $CODE_ROOT_STATE; workspace seed left as deployed." >&2
  code_root_event companion_seed skipped "$CODE_ROOT_STATE"
fi

echo "[lite] Starting ClawMobile Companion server on ${CLAWMOBILE_COMPANION_HOST:-auto}:${CLAWMOBILE_COMPANION_PORT}"
echo "[lite] OpenClaw gateway target is ${CLAWMOBILE_GATEWAY_HOST}:${CLAWMOBILE_GATEWAY_PORT}"
# The existing Companion owner consumes its own output so a renamed open fd
# cannot keep growing an archive forever. No extra daemon or periodic task.
COMPANION_LOG_DIR="$HOME/.openclaw/health"
mkdir -p "$COMPANION_LOG_DIR"
node "$PLUGIN_DIR/dist/companion/server.js" 2>&1 | python3 "$SCRIPT_DIR/bounded-log.py" "$COMPANION_LOG_DIR/companion.stderr.log" --stream --timestamp
