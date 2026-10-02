#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

tmp_root="$(mktemp -d "${TMPDIR:-$HOME/.openclaw/tmp}/clawmobile-plugin-uninstall-test.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT
log="$tmp_root/openclaw.log"
extension_dir="$tmp_root/extension"
mkdir -p "$extension_dir"

openclaw() {
  printf '%s\n' "$*" >> "$log"
  return 0
}

clawmobile_remove_plugin_registration "openclaw-plugin-mobile-ui" "$extension_dir"

grep -Fqx 'plugins uninstall openclaw-plugin-mobile-ui --keep-files --force' "$log"
grep -Fqx 'config unset plugins.entries["openclaw-plugin-mobile-ui"]' "$log"
grep -Fqx 'config unset plugins.installs["openclaw-plugin-mobile-ui"]' "$log"
grep -Fqx 'plugins registry --refresh' "$log"

if [ -d "$extension_dir" ]; then
  echo "extension_not_removed" >&2
  exit 1
fi

echo "plugin uninstall noninteractive test: PASS"
