#!/usr/bin/env bash
# activate-ui-playbooks.sh links git-ignored runtime dependencies into the pinned snapshot and refuses a
# snapshot whose declared packages do not resolve (S24 11/10: billing CLI ERR_MODULE_NOT_FOUND in every snapshot).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home" CLAW_UI_PLAYBOOKS_WORKSPACE="$tmp/ws" CLAW_NODE="$(command -v node)"
# Surface-view compiler stub: records which snapshot was pinned when it ran (S24 17/10: stale views after a pin).
cat > "$tmp/compile-stub.py" <<'PY'
import os,sys
assert sys.argv[1:]==["compile"],sys.argv
cur=os.path.realpath(os.path.expanduser("~/.openclaw/runtime-ui-playbooks/current"))
open(os.environ["COMPILE_LOG"],"a").write(os.path.basename(cur)+"\n")
PY
export CLAW_CAPABILITY_CLI="$tmp/compile-stub.py" COMPILE_LOG="$tmp/compile.log"
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
# Views are recompiled after the switch, against the newly pinned snapshot.
[ "$(tail -n 1 "$tmp/compile.log")" = "$sha" ] || { echo "views not recompiled for $sha" >&2; exit 1; }
# Re-pinning the active snapshot still refreshes possibly stale views.
bash "$here/activate-ui-playbooks.sh" HEAD > "$tmp/out-again" 2>&1
grep -q "ALREADY_ACTIVE $sha" "$tmp/out-again"
[ "$(wc -l < "$tmp/compile.log")" -eq 2 ]
# A failing compiler is reported, never fatal for the pin.
CLAW_CAPABILITY_CLI="$tmp/missing.py" bash "$here/activate-ui-playbooks.sh" HEAD > "$tmp/out-fail" 2>&1
grep -q "capability_views_compile_failed" "$tmp/out-fail"

# A declared package missing from the workspace refuses the snapshot and keeps the current one.
echo '{"type":"module","dependencies":{"tough-cookie":"^5","undici":"^6"}}' > billing/direct-runtime/package.json
git commit -qam missing
if bash "$here/activate-ui-playbooks.sh" HEAD > "$tmp/out2" 2>&1; then echo "missing dependency was activated" >&2; exit 1; fi
grep -q "runtime_dependencies_unresolved billing/direct-runtime" "$tmp/out2"
[ "$(readlink "$HOME/.openclaw/runtime-ui-playbooks/current")" = "$HOME/.openclaw/runtime-ui-playbooks/$sha" ]

# Retention: after 8 more activations only current, previous and the 5 newest snapshots remain.
echo '{"type":"module","dependencies":{"tough-cookie":"^5"}}' > billing/direct-runtime/package.json
git commit -qam fixed
for i in 1 2 3 4 5 6 7 8; do echo "$i" > "f$i"; git add "f$i"; git commit -qm "c$i"; bash "$here/activate-ui-playbooks.sh" HEAD >/dev/null 2>&1 || { echo "activation $i failed" >&2; exit 1; }; done
count=$(ls -1d "$HOME/.openclaw/runtime-ui-playbooks"/*/ | grep -Ec '/[0-9a-f]{40}/$')
[ "$count" -le 6 ] || { echo "retention kept $count snapshots" >&2; exit 1; }
[ -d "$(readlink "$HOME/.openclaw/runtime-ui-playbooks/current")" ] && [ -d "$(readlink "$HOME/.openclaw/runtime-ui-playbooks/previous")" ]
[ -z "$(git worktree list --porcelain | grep -c prunable | grep -v '^0$')" ]

# Rollback relinks dependencies of a snapshot created before the link existed.
prev=$(readlink "$HOME/.openclaw/runtime-ui-playbooks/previous"); rm -f "$prev/billing/direct-runtime/node_modules"
bash "$here/activate-ui-playbooks.sh" --rollback >/dev/null
[ -L "$prev/billing/direct-runtime/node_modules" ]
[ "$(tail -n 1 "$tmp/compile.log")" = "$(basename "$prev")" ] || { echo "views not recompiled after rollback" >&2; exit 1; }
# A commit merged on origin but not fetched yet is fetched, then activated (S24 25/10, fresh merge 698322f7).
git clone -q --bare "$CLAW_UI_PLAYBOOKS_WORKSPACE" "$tmp/origin.git"
git remote add origin "$tmp/origin.git" 2>/dev/null || git remote set-url origin "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/upstream" && (cd "$tmp/upstream" && git config user.email t@t && git config user.name t \
  && echo merged > merged.txt && git add merged.txt && git commit -qm merged && git push -q origin HEAD)
fresh=$(git -C "$tmp/upstream" rev-parse HEAD)
! git cat-file -e "$fresh^{commit}" 2>/dev/null || { echo "fixture already has the fresh commit" >&2; exit 1; }
bash "$here/activate-ui-playbooks.sh" "$fresh" > "$tmp/out-fresh" 2>&1 || { cat "$tmp/out-fresh" >&2; exit 1; }
grep -q "ACTIVATED $fresh" "$tmp/out-fresh"
# An unknown commit still fails, without switching the current snapshot.
before=$(readlink "$HOME/.openclaw/runtime-ui-playbooks/current")
if bash "$here/activate-ui-playbooks.sh" 0123456789abcdef0123456789abcdef01234567 > "$tmp/out-unknown" 2>&1; then echo "unknown commit was activated" >&2; exit 1; fi
[ "$(readlink "$HOME/.openclaw/runtime-ui-playbooks/current")" = "$before" ]
echo '{"ok":true,"linked":true,"unresolvedRefused":true,"retention":true,"rollbackLinked":true,"viewsRecompiled":true,"freshCommitFetched":true}'
