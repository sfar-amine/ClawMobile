#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

tmp_root="$(mktemp -d "${TMPDIR:-$HOME/.openclaw/tmp}/clawmobile-plugin-install-test.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT
log="$tmp_root/openclaw.log"

# The update path uses rsync on Termux. Keep this host test independent from
# the Ubuntu image's optional packages while preserving --delete semantics.
# The runtime-set section at the end (#126) needs the real rsync filters.
real_rsync="$(command -v rsync || true)"
mkdir -p "$tmp_root/bin"
cat >"$tmp_root/bin/rsync" <<'EOF_RSYNC'
#!/usr/bin/env bash
set -euo pipefail
src="${@: -2:1}"; dst="${@: -1}"
find "$dst" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "$src"/. "$dst"/
EOF_RSYNC
chmod +x "$tmp_root/bin/rsync"
PATH="$tmp_root/bin:$PATH"

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
grep -Fqx 'config set plugins.entries["openclaw-plugin-mobile-ui"].hooks.allowConversationAccess true' "$log"
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
grep -Fqx 'config set plugins.entries["openclaw-plugin-mobile-ui"].hooks.allowConversationAccess true' "$log"
[ -f "$first_plugin/.openclaw-plugin-installed-lite.stamp" ] || { echo "install_stamp_missing" >&2; exit 1; }

# #126: the Gateway copies the extension directory into its plugin source capture at each restart. Only dist and
# the two manifests are installed; sources, scripts, fixtures and earlier copies of them leave the extension, while
# its node_modules (ws) and stamp stay. Real rsync filters, not the stand-in above.
[ -n "$real_rsync" ] || { echo "runtime_set_needs_rsync" >&2; exit 1; }
mkdir -p "$tmp_root/real-bin"
ln -s "$real_rsync" "$tmp_root/real-bin/rsync"
: > "$log"
runtime_plugin="$tmp_root/runtime-plugin"
mkdir -p "$runtime_plugin/dist/companion" "$runtime_plugin/src" "$runtime_plugin/scripts" "$runtime_plugin/fixtures/s24"
printf '{"id":"openclaw-plugin-mobile-ui"}\n' > "$runtime_plugin/openclaw.plugin.json"
printf '{"dependencies":{"ws":"^8.22.0"}}\n' > "$runtime_plugin/package.json"
printf 'new-index\n' > "$runtime_plugin/dist/index.js"
printf 'new-server\n' > "$runtime_plugin/dist/companion/server.js"
for f in src/index.ts scripts/test.cjs fixtures/s24/capture.json tsconfig.json package-lock.json; do printf 'dev\n' > "$runtime_plugin/$f"; done
export OPENCLAW_STATE_DIR="$tmp_root/runtime-state"
runtime_extension="$OPENCLAW_STATE_DIR/extensions/openclaw-plugin-mobile-ui"
mkdir -p "$runtime_extension/dist" "$runtime_extension/node_modules/ws" "$runtime_extension/fixtures/old" "$runtime_extension/src" "$runtime_extension/scripts"
printf 'old-index\n' > "$runtime_extension/dist/index.js"
printf 'removed-module\n' > "$runtime_extension/dist/removed.js"
printf 'ws\n' > "$runtime_extension/node_modules/ws/index.js"
printf 'old\n' | tee "$runtime_extension/fixtures/old/a.json" "$runtime_extension/src/old.ts" "$runtime_extension/scripts/old.cjs" \
  "$runtime_extension/tsconfig.json" "$runtime_extension/package-lock.json" > /dev/null
: > "$runtime_extension/.openclaw-plugin-installed-lite.stamp"

PATH="$tmp_root/real-bin:$PATH" clawmobile_install_plugin "$runtime_plugin"

installed="$(cd "$runtime_extension" && find . -type f | LC_ALL=C sort | tr '\n' ' ')"
expected="./.openclaw-plugin-installed-lite.stamp ./dist/companion/server.js ./dist/index.js ./node_modules/ws/index.js ./openclaw.plugin.json ./package.json "
[ "$installed" = "$expected" ] || { echo "runtime_set_mismatch: $installed" >&2; exit 1; }
grep -Fqx 'new-index' "$runtime_extension/dist/index.js"
grep -Fqx 'ws' "$runtime_extension/node_modules/ws/index.js"
for d in fixtures src scripts; do [ ! -e "$runtime_extension/$d" ] || { echo "dev_dir_left_in_extension: $d" >&2; exit 1; }; done
[ -f "$runtime_plugin/src/index.ts" ] && [ -f "$runtime_plugin/fixtures/s24/capture.json" ] || { echo "checkout_modified" >&2; exit 1; }

echo "plugin install noninteractive test: PASS"
