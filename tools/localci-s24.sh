#!/data/data/com.termux/files/usr/bin/bash
# S24 entry of the canonical local CI (Amine 24/10: development, tests and delivery without a PC).
# Usage: tools/localci-s24.sh <repo-name> <40-char-head-sha> <PR|-> [pr-body-file]
#
# Termux side: fetches the exact head (and refs/pull/N/{head,merge}) with the S24's existing git
# access, then runs THIS checkout's tools/localci.py inside the proot Debian with an empty
# environment, the Debian toolchains (tools/localci_s24_toolchain.sh) and the deploy lock bound
# for localci to hold exclusively. The full log and a receipt stay under ~/.cache/localci-s24/.
set -euo pipefail
name="${1:-}"; sha="${2:-}"; pr="${3:-}"; body="${4:-}"
case "$name" in samantha-core|samantha-ui-playbooks|samantha-context-private) ;;
  *) echo "usage: $0 <samantha-core|samantha-ui-playbooks|samantha-context-private> <sha40> <PR|-> [pr-body-file]" >&2; exit 2;; esac
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "full 40-character head SHA required" >&2; exit 2; }
[[ "$pr" == - || "$pr" =~ ^[1-9][0-9]*$ ]] || { echo "PR number or - required" >&2; exit 2; }
[ -z "$body" ] || [ -f "$body" ] || { echo "PR body file not found: $body" >&2; exit 2; }

owner="$(cd "$(dirname "$0")/.." && pwd)"
ci="$HOME/.cache/localci-s24"; repo="$ci/repos/$name"; logs="$ci/logs"
mkdir -p "$ci/repos" "$logs" "$ci/tmp" "$HOME/.openclaw/deploys"
# Every Samantha repository is mirrored: workflows read their peer at a branch head (`gh api`, served
# from these mirrors by tools/localci_s24_gh.py since the S24 has git access but no gh token).
for peer in samantha-core samantha-ui-playbooks; do
  [ -d "$ci/repos/$peer/.git" ] || git clone -q "git@github.com:sfar-amine/$peer.git" "$ci/repos/$peer"
  git -C "$ci/repos/$peer" fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
done
[ -d "$repo/.git" ] || git clone -q "git@github.com:sfar-amine/$name.git" "$repo"
git -C "$repo" fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
# Steps fetching a Samantha repository from GitHub by URL get the same objects from these mirrors.
for peer in samantha-core samantha-ui-playbooks; do ln -sfn "$peer" "$ci/repos/$peer.git"; done
mkdir -p "$ci/bin"
printf '#!/bin/sh\nexec python3 /owner/tools/localci_s24_gh.py "$@"\n' > "$ci/bin/gh"; chmod +x "$ci/bin/gh"
if [ "$pr" != - ]; then
  git -C "$repo" fetch -q origin "+refs/pull/$pr/head:refs/localci/pull/$pr/head"
  git -C "$repo" fetch -q origin "+refs/pull/$pr/merge:refs/localci/pull/$pr/merge" \
    || echo "LOCALCI_S24 note=pr_merge_ref_unavailable pr=$pr" >&2
fi
git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$repo" fetch -q origin "$sha"

stamp="$(date +%Y%m%dT%H%M%S)"
log="$name-${sha:0:12}-pr$pr-$stamp.log"
body_env=()
if [ -n "$body" ]; then cp "$body" "$ci/tmp/pr-body-$stamp.md"; body_env=("LOCALCI_PR_BODY_FILE=/ci/tmp/pr-body-$stamp.md"); fi
started="$(date +%s)"
set +e
nice -n 10 proot-distro login debian --bind "$ci:/ci" --bind "$HOME/.openclaw/deploys:/locks" --bind "$owner:/owner" -- \
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
    LOCALCI_PROFILE=s24 LOCALCI_HEAVY_LOCK=/locks/companion-deploy.lock LOCALCI_TMP_ROOT=/ci/tmp \
    LOCALCI_NODE20_BIN=/opt/node20/bin LOCALCI_NODE22_BIN=/opt/node22/bin LOCALCI_NODE26_BIN=/opt/node26/bin \
    LOCALCI_PYTHON312_BIN=/opt/python3.12/bin LOCALCI_S24_STEP_BIN=/ci/bin LOCALCI_S24_MIRRORS=/ci/repos \
    GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' \
    GIT_CONFIG_KEY_1=url./ci/repos/.insteadOf GIT_CONFIG_VALUE_1=https://github.com/sfar-amine/ \
    GIT_CONFIG_KEY_2=url./ci/repos/.insteadOf GIT_CONFIG_VALUE_2=git@github.com:sfar-amine/ \
    GIT_CONFIG_KEY_3=uploadpack.allowAnySHA1InWant GIT_CONFIG_VALUE_3=true "${body_env[@]}" \
    python3 /owner/tools/localci.py "/ci/repos/$name" "$sha" "$pr" "/ci/logs/$log" >/dev/null 2>"$logs/$log.stderr"
code=$?
set -e
result="$(grep -h '^LOCALCI_RESULT' "$logs/$log" "$logs/$log.stderr" 2>/dev/null | tail -1)"
digest="$(sha256sum "$logs/$log" 2>/dev/null | cut -d' ' -f1)"
python3 - "$logs/$log.receipt.json" <<EOF
import json, sys
json.dump({"version": 1, "kind": "localci_s24", "repository": "$name", "head": "$sha", "pr": "$pr",
           "exit_code": $code, "result": """$result""", "log": "$logs/$log", "log_sha256": "$digest" or None,
           "owner_revision": "$(git -C "$owner" rev-parse HEAD 2>/dev/null || echo unknown)",
           "started_at": $started, "finished_at": $(date +%s)}, open(sys.argv[1], "w"), indent=2)
EOF
echo "LOCALCI_S24 exit=$code receipt=$logs/$log.receipt.json $result"
exit "$code"
