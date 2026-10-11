#!/data/data/com.termux/files/usr/bin/bash
# Pin the runtime ui-playbooks snapshot read by claw-capability.py and model-fast-path.py.
#   activate-ui-playbooks.sh <commit>   verify then switch ~/.openclaw/runtime-ui-playbooks/current
#   activate-ui-playbooks.sh --rollback switch back to the previous snapshot
# Helpers are spawned per request, so the switch applies without restarting any service.
set -euo pipefail
W="${CLAW_UI_PLAYBOOKS_WORKSPACE:-$HOME/.openclaw/workspace/ui-playbooks}"
D="$HOME/.openclaw/runtime-ui-playbooks"
swap() { # atomic symlink replace (toybox mv -T is not available on the S24)
  python3 -c 'import os,sys;n=sys.argv[1]+".next";os.path.lexists(n) and os.remove(n);os.symlink(sys.argv[2],n);os.replace(n,sys.argv[1])' "$D/$1" "$2"
}
mkdir -p "$D"
if [ "${1:-}" = "--rollback" ]; then
  prev=$(readlink "$D/previous" 2>/dev/null) || { echo "no_previous_snapshot" >&2; exit 2; }
  cur=$(readlink "$D/current")
  swap current "$prev"; swap previous "$cur"
  echo "ROLLED_BACK current=$(basename "$prev")"; exit 0
fi
[ -n "${1:-}" ] || { echo "usage: $0 <commit>|--rollback" >&2; exit 2; }
sha=$(git -C "$W" rev-parse --verify "$1^{commit}")
[ -d "$D/$sha" ] || git -C "$W" worktree add -q --detach "$D/$sha" "$sha"
# Git-ignored runtime dependencies (e.g. billing/direct-runtime/node_modules) never reach a fresh worktree:
# link each one from the workspace, then refuse the snapshot if a declared package still does not resolve
# (S24 11/10: billing CLI ERR_MODULE_NOT_FOUND 'tough-cookie' in every activated snapshot).
NODE="${CLAW_NODE:-$HOME/.openclaw-android/bin/node}"
while IFS= read -r rel; do
  [ -d "$D/$sha/$(dirname "$rel")" ] || continue
  [ -e "$D/$sha/$rel" ] || ln -s "$W/$rel" "$D/$sha/$rel"
  [ -f "$D/$sha/$(dirname "$rel")/package.json" ] || continue
  "$NODE" -e 'const d=process.argv[1],p=require(d+"/package.json");for(const n of Object.keys(p.dependencies||{}))require.resolve(n+"/package.json",{paths:[d]})' "$D/$sha/$(dirname "$rel")" \
    || { echo "runtime_dependencies_unresolved $(dirname "$rel")" >&2; exit 3; }
done < <(cd "$W" && find . -maxdepth 4 -path ./.git -prune -o -type d -name node_modules -print -prune | sed 's|^\./||')
(cd "$D/$sha" && PYTHONPATH=. python3 -B -m unittest -q tests.test_capability_decision_contract tests.test_composed_reads)
cur=$(readlink "$D/current" 2>/dev/null || true)
if [ "$cur" = "$D/$sha" ]; then echo "ALREADY_ACTIVE $sha"; exit 0; fi
[ -n "$cur" ] && swap previous "$cur"
swap current "$D/$sha"
echo "ACTIVATED $sha previous=$(basename "${cur:-none}")"
