#!/usr/bin/env bash
# One CI leg of the OpenClaw SDK surface qualification, run once per pinned version (CI parameter, no matrix:
# tools/localci.py runs workflow steps in sequence). Fetches the public npm tar, checks its SHA256, extracts only
# package.json, the plugin-sdk facades and the model-flow-selection modules of that version, applies that set with
# its existing owner, then checks the plugin's version table statically. Never installs or runs OpenClaw code.
# Usage (from openclaw-plugin-mobile-ui, after npm run build): scripts/openclaw-sdk-surface-ci.sh <version> <sha256> <workdir>
set -euo pipefail
version="$1" sha="$2" work="$3"
case "$version" in *[!0-9.]*|'') echo "invalid version" >&2; exit 2;; esac
case "$sha" in *[!0-9a-f]*|'') echo "invalid sha256" >&2; exit 2;; esac
[ "${#sha}" -eq 64 ] || { echo "invalid sha256" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
compat="$here/../../installer/termux-lite/openclaw-compat"
mkdir -p "$work"
tarball="$work/openclaw-$version.tgz"
root="$work/openclaw-$version"
[ -f "$tarball" ] || curl --fail --silent --show-error --location \
  "https://registry.npmjs.org/openclaw/-/openclaw-$version.tgz" --output "$tarball"
echo "$sha  $tarball" | sha256sum --check
rm -rf "$root"; mkdir -p "$root"
members="$work/members-$version.txt"
python3 -I - "$compat/model-flow-selection.json" "$version" > "$members" <<'PY'
import json, sys
manifest, version = json.load(open(sys.argv[1])), sys.argv[2]
files = manifest["files"] if manifest["package_version"] == version else manifest["packages"][version]["files"]
print("\n".join("package/" + row["path"] for row in files if row["root"] == "openclaw"))
PY
tar -xzf "$tarball" -C "$root" --wildcards 'package/package.json' 'package/dist/plugin-sdk/*.js' -T "$members"
python3 "$compat/whatsapp-network-recovery.py" --patch-set model-flow-selection --openclaw-root "$root/package" --apply
node "$here/qualify-openclaw-sdk.cjs" "$root/package" "$version" --require-contract-export
rm -rf "$root" "$tarball" "$members"
