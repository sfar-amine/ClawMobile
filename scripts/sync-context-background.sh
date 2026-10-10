#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

REPO="${SAMANTHA_CONTEXT_REPO:-$HOME/samantha-context-private}"
WS="${SAMANTHA_CONTEXT_WORKSPACE:-$HOME/.openclaw/workspace}"
[ -e "$REPO/.git" ] || exit 0
cd "$REPO"

# Refresh only the curated files already owned by the private context repository.
# Never mirror the workspace: logs, credentials and transcripts are excluded.
copy_curated() {
  local source="$WS/$1" target="$REPO/$2"
  [ -f "$source" ] || return 0
  [ ! -e "$target" ] || [ ! "$source" -ef "$target" ] || return 0
  mkdir -p "$(dirname "$target")"
  if [ -f "$target" ] && cmp -s "$source" "$target"; then return 0; fi
  cp -p -- "$source" "$target"
}
copy_curated USER.md people/USER.md
copy_curated context/USER_PREFERENCES.md people/USER_PREFERENCES.md
copy_curated context/OPERATING_RULES.md OPERATING_RULES.md
copy_curated context/WORK_CONTEXT.md people/WORK_CONTEXT.md
copy_curated DREAMS.md state/DREAMS.md
copy_curated context/HYBRID_CONTEXT.md state/HYBRID_CONTEXT.md

had_changes="$(git status --porcelain)"
# save.sh also refreshes the canonical semantic-state export: a clean snapshot
# repository does not prove that the runtime store itself is unchanged.
bash ./scripts/save.sh
if [ -z "$had_changes" ]; then
  git fetch origin
  git pull --ff-only origin main
fi
