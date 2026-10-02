#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

tmp_root="$(mktemp -d "${TMPDIR:-$HOME/.openclaw/tmp}/clawmobile-plugin-install-test.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT
log="$tmp_root/openclaw.log"

openclaw() {
  printf '%s\n' "$*" >> "$log"
  if [ "${1:-}" = "plugins" ] && [ "${2:-}" = "install" ] && [ "${3:-}" = "--help" ]; then
    cat <<'EOF'
--force
--accept-capabilities
--acknowledge-install-policy-warning
--dangerously-force-unsafe-install
EOF
  fi
  return 0
}

extension_dir="$tmp_root/remove-extension"
mkdir -p "$extension_dir"
clawmobile_remove_plugin_registration "openclaw-plugin-mobile-ui" "$extension_dir"

grep -Fqx 'plugins uninstall openclaw-plugin-mobile-ui --keep-files --force' "$log"
grep -Fqx 'config unset plugins.entries["openclaw-plugin-mobile-ui"]' "$log"
grep -Fqx 'config unset plugins.installs["openclaw-plugin-mobile-ui"]' "$log"
grep -Fqx 'plugins registry --refresh' "$log"

if [ -d "$extension_dir" ]; then
  echo "extension_not_removed" >&2
  exit 1
fi

: > "$log"
plugin_dir="$tmp_root/plugin"
mkdir -p "$plugin_dir/dist"
printf '{}\n' > "$plugin_dir/openclaw.plugin.json"
printf '{}\n' > "$plugin_dir/package.json"
printf 'module.exports = {}\n' > "$plugin_dir/dist/index.js"
export OPENCLAW_STATE_DIR="$tmp_root/state"
export CLAWMOBILE_TERMUX_FORCE_PLUGIN_INSTALL=1
mkdir -p "$OPENCLAW_STATE_DIR/extensions/openclaw-plugin-mobile-ui"

clawmobile_install_plugin "$plugin_dir"

grep -Fqx 'plugins uninstall openclaw-plugin-mobile-ui --keep-files --force' "$log"
grep -Fqx "plugins install --force --accept-capabilities --acknowledge-install-policy-warning $plugin_dir" "$log"
grep -Fqx 'plugins enable openclaw-plugin-mobile-ui' "$log"
grep -Fqx 'config set plugins.entries["openclaw-plugin-mobile-ui"].enabled true' "$log"

if [ ! -f "$plugin_dir/.openclaw-plugin-installed-lite.stamp" ]; then
  echo "install_stamp_missing" >&2
  exit 1
fi

echo "plugin install noninteractive test: PASS"
