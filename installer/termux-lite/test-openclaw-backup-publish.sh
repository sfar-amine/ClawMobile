#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
PATCH="$R/openclaw-compat/patch-openclaw-paths.sh"
TMP_ROOT="$(mktemp -d "$HOME/.cache/tmp/openclaw-backup-publish-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/npm-root/openclaw/node_modules/@openclaw/fs-safe/dist"
cat >"$TMP_ROOT/bin/npm" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
[ "\${1:-}" = root ] && [ "\${2:-}" = -g ] && { printf '%s\n' "$TMP_ROOT/npm-root"; exit 0; }
exit 1
EOF
chmod +x "$TMP_ROOT/bin/npm"
TARGET="$TMP_ROOT/npm-root/openclaw/node_modules/@openclaw/fs-safe/dist/publish-file.js"
cat >"$TARGET" <<'EOF'
const HARDLINK_FALLBACK_CODES = new Set(["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);
const NATIVE_COPY_FALLBACK_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);
export function isHardlinkFallbackError(error) {
  return HARDLINK_FALLBACK_CODES.has(error?.code ?? "");
}
export function isNativeCopyFallbackError(error) {
  return NATIVE_COPY_FALLBACK_CODES.has(error?.code ?? "");
}
EOF
PATH="$TMP_ROOT/bin:$PATH" PREFIX="/data/data/com.termux/files/usr" bash "$PATCH" >/dev/null
grep -Fq 'HARDLINK_FALLBACK_CODES = new Set(["EACCES", "EPERM"' "$TARGET"
grep -Fq 'NATIVE_COPY_FALLBACK_CODES = new Set(["EACCES", "EINVAL"' "$TARGET"
node --input-type=module - "$TARGET" <<'NODE'
const target=process.argv[2];
const m=await import('file://'+target+'?v='+Date.now());
if(!m.isHardlinkFallbackError({code:'EACCES'})) throw new Error('EACCES hardlink fallback missing');
if(!m.isNativeCopyFallbackError({code:'EACCES'})) throw new Error('EACCES native-copy fallback missing');
if(m.isHardlinkFallbackError({code:'EEXIST'})) throw new Error('collision must remain terminal');
NODE
# Idempotence and no duplicate policy entries.
PATH="$TMP_ROOT/bin:$PATH" PREFIX="/data/data/com.termux/files/usr" bash "$PATCH" >/dev/null
test "$(grep -Fc 'HARDLINK_FALLBACK_CODES = new Set(["EACCES",' "$TARGET")" -eq 1
test "$(grep -Fc 'NATIVE_COPY_FALLBACK_CODES = new Set(["EACCES",' "$TARGET")" -eq 1
echo "openclaw backup publication compatibility: PASS"
