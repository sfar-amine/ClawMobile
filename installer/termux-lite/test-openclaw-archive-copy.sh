#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
PATCH="$R/openclaw-compat/patch-openclaw-paths.sh"
TMP_ROOT="$(mktemp -d "$HOME/.cache/tmp/openclaw-archive-patch-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/npm-root/openclaw/dist"
cat >"$TMP_ROOT/bin/npm" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
[ "\${1:-}" = root ] && [ "\${2:-}" = -g ] && { printf '%s\n' "$TMP_ROOT/npm-root"; exit 0; }
exit 1
EOF
chmod +x "$TMP_ROOT/bin/npm"
TARGET="$TMP_ROOT/npm-root/openclaw/dist/session-accessor.sqlite-archive-artifact-test.mjs"
cat >"$TARGET" <<'EOF'
import fs from "node:fs";
function publish(tempPath, archivePath) {
  try {
    fs.linkSync(tempPath, archivePath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
EOF
PATH="$TMP_ROOT/bin:$PATH" PREFIX="/data/data/com.termux/files/usr" bash "$PATCH" >/dev/null
grep -Fq 'fs.copyFileSync(tempPath, archivePath, fs.constants.COPYFILE_EXCL);' "$TARGET"
grep -Fq 'fs.fsyncSync(publishedFd);' "$TARGET"
! grep -Fq 'fs.linkSync(tempPath, archivePath);' "$TARGET"
# Idempotence: a second patch pass must leave the already-patched fixture valid.
PATH="$TMP_ROOT/bin:$PATH" PREFIX="/data/data/com.termux/files/usr" bash "$PATCH" >/dev/null
test "$(grep -Fc 'fs.copyFileSync(tempPath, archivePath, fs.constants.COPYFILE_EXCL);' "$TARGET")" -eq 1
node - "$TMP_ROOT" <<'NODE'
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=process.argv[2],src=path.join(root,'source'),dst=path.join(root,'dest');
fs.writeFileSync(src,'archive',{mode:0o600});
fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL);
const fd=fs.openSync(dst,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
if(fs.readFileSync(dst,'utf8')!=='archive')throw new Error('copy_readback_failed');
let collision='';try{fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL);}catch(e){collision=e.code;}
if(collision!=='EEXIST')throw new Error('exclusive_copy_contract_failed:'+collision);
NODE
echo "openclaw archive copy compatibility: PASS"
