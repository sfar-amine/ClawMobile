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
[ ! -d "$extension_dir" ] || { echo "extension_not_removed" >&2; exit 1; }

: > "$log"
plugin_dir="$tmp_root/update-plugin"
mkdir -p "$plugin_dir/dist"
printf '{}\n' > "$plugin_dir/openclaw.plugin.json"
printf '{}\n' > "$plugin_dir/package.json"
printf 'new-content\n' > "$plugin_dir/dist/index.js"
export OPENCLAW_STATE_DIR="$tmp_root/update-state"
export CLAWMOBILE_TERMUX_FORCE_PLUGIN_INSTALL=1
update_extension="$OPENCLAW_STATE_DIR/extensions/openclaw-plugin-mobile-ui"
mkdir -p "$update_extension/dist"
printf 'old-content\n' > "$update_extension/dist/index.js"
printf 'stale\n' > "$update_extension/stale.txt"

clawmobile_install_plugin "$plugin_dir"

grep -Fqx 'config set plugins.entries["openclaw-plugin-mobile-ui"].enabled true' "$log"
if grep -q '^plugins uninstall ' "$log" || grep -q '^plugins install ' "$log"; then
  echo "update_used_plugin_cli" >&2
  exit 1
fi
grep -Fqx 'new-content' "$update_extension/dist/index.js"
[ ! -e "$update_extension/stale.txt" ] || { echo "stale_file_not_removed" >&2; exit 1; }
[ -f "$plugin_dir/.openclaw-plugin-installed-lite.stamp" ] || { echo "update_stamp_missing" >&2; exit 1; }

: > "$log"
first_plugin="$tmp_root/first-plugin"
mkdir -p "$first_plugin/dist"
printf '{}\n' > "$first_plugin/openclaw.plugin.json"
printf '{}\n' > "$first_plugin/package.json"
printf 'module.exports = {}\n' > "$first_plugin/dist/index.js"
export OPENCLAW_STATE_DIR="$tmp_root/first-state"
mkdir -p "$OPENCLAW_STATE_DIR/extensions"

clawmobile_install_plugin "$first_plugin"

grep -Fqx 'plugins uninstall openclaw-plugin-mobile-ui --keep-files --force' "$log"
grep -Fqx "plugins install --force --accept-capabilities --acknowledge-install-policy-warning $first_plugin" "$log"
grep -Fqx 'plugins enable openclaw-plugin-mobile-ui' "$log"
grep -Fqx 'config set plugins.entries["openclaw-plugin-mobile-ui"].enabled true' "$log"
[ -f "$first_plugin/.openclaw-plugin-installed-lite.stamp" ] || { echo "install_stamp_missing" >&2; exit 1; }

echo "plugin install noninteractive test: PASS"
