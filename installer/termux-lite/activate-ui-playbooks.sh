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
NODE="${CLAW_NODE:-$HOME/.openclaw-android/bin/node}"
# Git-ignored runtime dependencies (e.g. billing/direct-runtime/node_modules) never reach a fresh worktree:
# link each one from the workspace, then refuse the snapshot if a declared package still does not resolve
# (S24 11/10: billing CLI ERR_MODULE_NOT_FOUND 'tough-cookie' in every activated snapshot).
link_deps(){ # $1 = snapshot dir
while IFS= read -r rel; do
  [ -d "$1/$(dirname "$rel")" ] || continue
  [ -e "$1/$rel" ] || ln -s "$W/$rel" "$1/$rel"
  [ -f "$1/$(dirname "$rel")/package.json" ] || continue
  # Presence check, not require.resolve: packages with an "exports" map hide package.json (tough-cookie, parse5).
  "$NODE" -e 'const fs=require("fs"),d=process.argv[1],p=require(d+"/package.json");for(const n of Object.keys(p.dependencies||{}))if(!fs.existsSync(d+"/node_modules/"+n+"/package.json"))process.exit(1)' "$1/$(dirname "$rel")" \
    || { echo "runtime_dependencies_unresolved $(dirname "$rel")" >&2; return 3; }
done < <(cd "$W" && find . -maxdepth 4 -path ./.git -prune -o -type d -name node_modules -print -prune | sed 's|^\./||')
}
mkdir -p "$D"
if [ "${1:-}" = "--rollback" ]; then
  prev=$(readlink "$D/previous" 2>/dev/null) || { echo "no_previous_snapshot" >&2; exit 2; }
  cur=$(readlink "$D/current")
  link_deps "$prev" || exit 3
  swap current "$prev"; swap previous "$cur"
  echo "ROLLED_BACK current=$(basename "$prev")"; exit 0
fi
[ -n "${1:-}" ] || { echo "usage: $0 <commit>|--rollback" >&2; exit 2; }
sha=$(git -C "$W" rev-parse --verify "$1^{commit}")
[ -d "$D/$sha" ] || git -C "$W" worktree add -q --detach "$D/$sha" "$sha"
link_deps "$D/$sha" || exit 3
(cd "$D/$sha" && PYTHONPATH=. python3 -B -m unittest -q tests.test_capability_decision_contract tests.test_composed_reads)
cur=$(readlink "$D/current" 2>/dev/null || true)
if [ "$cur" = "$D/$sha" ]; then echo "ALREADY_ACTIVE $sha"; exit 0; fi
[ -n "$cur" ] && swap previous "$cur"
swap current "$D/$sha"
echo "ACTIVATED $sha previous=$(basename "${cur:-none}")"
# Retention (S24 11/10: 50 snapshots, ~450 MB/day): keep current, previous and the KEEP newest.
KEEP="${CLAW_UI_PLAYBOOKS_KEEP:-5}"; keepers="$(readlink "$D/current") $(readlink "$D/previous" 2>/dev/null || true)"
ls -1dt "$D"/*/ 2>/dev/null | sed 's|/$||' | tail -n +$((KEEP+1)) | while IFS= read -r old; do
  case " $keepers " in *" $old "*) continue;; esac
  [[ "$(basename "$old")" =~ ^[0-9a-f]{40}$ ]] || continue
  git -C "$W" worktree remove --force "$old" 2>/dev/null || rm -rf -- "$old"
done
git -C "$W" worktree prune 2>/dev/null || true
