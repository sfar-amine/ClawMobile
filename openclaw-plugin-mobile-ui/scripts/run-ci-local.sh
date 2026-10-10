#!/usr/bin/env bash
# Run the plugin's CI test steps on a device (e.g. the S24) exactly as .github/workflows/ci.yml lists them.
# Only difference: steps pinned to TMPDIR=/tmp use the local TMPDIR when /tmp is not writable (Termux).
set -euo pipefail
cd "$(dirname "$0")/.."
ci=../.github/workflows/ci.yml
steps=$(awk '/^ *run: \|/{f=1;next} f&&/^ *- name|^ *run:/{f=0} f' "$ci"; grep -E '^ *run: (node|python3|npm run)' "$ci" | sed 's/^ *run: //')
[ -w /tmp ] || steps=$(printf '%s\n' "$steps" | sed 's|^ *TMPDIR=/tmp ||')
printf '%s\n' "$steps" | sed 's/^ *//' | grep -v '^$' | while IFS= read -r step; do
  echo "== $step"; bash -c "$step" >/dev/null 2>"${TMPDIR:-/tmp}/ci-local.err" || { tail -20 "${TMPDIR:-/tmp}/ci-local.err"; echo "FAIL $step"; exit 1; }
done
echo CI_LOCAL_OK
