#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERMUX_PREFIX="/data/data/com.termux/files/usr"
SAFE_TMP="${TMPDIR:-$TERMUX_PREFIX/tmp}"
TEST_ROOT="$(mktemp -d "$SAFE_TMP/clawmobile-tmp-paths.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

actual="$(
  env -u TMPDIR -u PREFIX HOME="$HOME" "$TERMUX_PREFIX/bin/bash" -c '
    source "$1"
    clawmobile_lite_env
    printf "%s" "$TMPDIR"
  ' _ "$ROOT/lib.sh"
)"
if [ "$actual" != "$TERMUX_PREFIX/tmp" ]; then
  echo "unexpected fallback TMPDIR: $actual" >&2
  exit 1
fi

for file in "$ROOT/clawmobile" "$ROOT/lib.sh" "$ROOT/bootstrap.sh"; do
  if grep -Fq '${TMPDIR:-/tmp}' "$file"; then
    echo "unsafe TMPDIR fallback remains in $file" >&2
    exit 1
  fi
  if grep -Fq '${PREFIX:-/tmp}' "$file"; then
    echo "unsafe PREFIX fallback remains in $file" >&2
    exit 1
  fi
done

FAKE_ROOT="$TEST_ROOT/npm-root"
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_ROOT/openclaw/dist" "$FAKE_BIN" "$TEST_ROOT/tmp"

cat > "$FAKE_ROOT/openclaw/dist/crabbox-wrapper.js" <<'JS'
const a = "if [ -z \"${TMPDIR:-}\" ]; then export TMPDIR=\"/tmp\"; fi;";
const b = "if [ ! -d \"$TMPDIR\" ]; then mkdir -p \"$TMPDIR\" 2>/dev/null || export TMPDIR=\"/tmp\"; fi;";
const c = "tmp_script=\"$(mktemp \"${TMPDIR:-/tmp}/openclaw-crabbox-script.XXXXXX\")\" || exit $?";
JS

cat > "$FAKE_BIN/npm" <<'EOF_NPM'
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
if [ "${1:-}" = "root" ] && [ "${2:-}" = "-g" ]; then
  printf '%s\n' "$FAKE_NPM_ROOT"
  exit 0
fi
exit 2
EOF_NPM
chmod +x "$FAKE_BIN/npm"

PATH="$FAKE_BIN:$PATH" \
FAKE_NPM_ROOT="$FAKE_ROOT" \
PREFIX="$TERMUX_PREFIX" \
TMPDIR="$TEST_ROOT/tmp" \
"$TERMUX_PREFIX/bin/bash" "$ROOT/openclaw-compat/patch-openclaw-paths.sh" >/dev/null

fixture="$FAKE_ROOT/openclaw/dist/crabbox-wrapper.js"
if grep -Fq '\"/tmp\"' "$fixture"; then
  echo "escaped /tmp fallback was not patched" >&2
  exit 1
fi
if grep -Fq '${TMPDIR:-/tmp}' "$fixture"; then
  echo "parameter /tmp fallback was not patched" >&2
  exit 1
fi
grep -Fq '\"/data/data/com.termux/files/usr/tmp\"' "$fixture"
grep -Fq '${TMPDIR:-/data/data/com.termux/files/usr/tmp}' "$fixture"

echo "termux tmp path tests: PASS"
