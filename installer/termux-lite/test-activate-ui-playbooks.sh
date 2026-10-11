#!/usr/bin/env bash
# activate-ui-playbooks.sh links git-ignored runtime dependencies into the pinned snapshot and refuses a
# snapshot whose declared packages do not resolve (S24 11/10: billing CLI ERR_MODULE_NOT_FOUND in every snapshot).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home" CLAW_UI_PLAYBOOKS_WORKSPACE="$tmp/ws" CLAW_NODE="$(command -v node)"
mkdir -p "$HOME" "$CLAW_UI_PLAYBOOKS_WORKSPACE"
cd "$CLAW_UI_PLAYBOOKS_WORKSPACE"
git init -q && git config user.email t@t && git config user.name t
mkdir -p tests billing/direct-runtime
: > tests/__init__.py
for t in test_capability_decision_contract test_composed_reads; do
  printf 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self): pass\n' > "tests/$t.py"
done
echo node_modules/ > .gitignore
echo '{"type":"module","dependencies":{"tough-cookie":"^5"}}' > billing/direct-runtime/package.json
git add -A && git commit -qm base
mkdir -p billing/direct-runtime/node_modules/tough-cookie
# Real tough-cookie/parse5 declare an "exports" map that hides package.json from require.resolve.
echo '{"name":"tough-cookie","version":"5.0.0","exports":{".":"./index.js"}}' > billing/direct-runtime/node_modules/tough-cookie/package.json
bash "$here/activate-ui-playbooks.sh" HEAD > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; exit 1; }
sha=$(git rev-parse HEAD)
grep -q "ACTIVATED $sha" "$tmp/out"
[ -L "$HOME/.openclaw/runtime-ui-playbooks/$sha/billing/direct-runtime/node_modules" ]
[ -f "$HOME/.openclaw/runtime-ui-playbooks/current/billing/direct-runtime/node_modules/tough-cookie/package.json" ]

# A declared package missing from the workspace refuses the snapshot and keeps the current one.
echo '{"type":"module","dependencies":{"tough-cookie":"^5","undici":"^6"}}' > billing/direct-runtime/package.json
git commit -qam missing
if bash "$here/activate-ui-playbooks.sh" HEAD > "$tmp/out2" 2>&1; then echo "missing dependency was activated" >&2; exit 1; fi
grep -q "runtime_dependencies_unresolved billing/direct-runtime" "$tmp/out2"
[ "$(readlink "$HOME/.openclaw/runtime-ui-playbooks/current")" = "$HOME/.openclaw/runtime-ui-playbooks/$sha" ]
echo '{"ok":true,"linked":true,"unresolvedRefused":true}'
