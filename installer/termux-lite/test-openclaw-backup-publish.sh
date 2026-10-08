#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
PATCH="$R/openclaw-compat/patch-openclaw-paths.sh"
TMP_ROOT="$(mktemp -d "$HOME/.cache/tmp/openclaw-backup-publish-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/npm-root/openclaw/node_modules/@openclaw/fs-safe/dist" "$TMP_ROOT/npm-root/openclaw/dist"
cat >"$TMP_ROOT/bin/npm" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
[ "\${1:-}" = root ] && [ "\${2:-}" = -g ] && { printf '%s\n' "$TMP_ROOT/npm-root"; exit 0; }
exit 1
EOF
chmod +x "$TMP_ROOT/bin/npm"
FSSAFE_TARGET="$TMP_ROOT/npm-root/openclaw/node_modules/@openclaw/fs-safe/dist/publish-file.js"
cat >"$FSSAFE_TARGET" <<'EOF'
const HARDLINK_FALLBACK_CODES = new Set(["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);
const NATIVE_COPY_FALLBACK_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);
export function isHardlinkFallbackError(error) {
  return HARDLINK_FALLBACK_CODES.has(error?.code ?? "");
}
export function isNativeCopyFallbackError(error) {
  return NATIVE_COPY_FALLBACK_CODES.has(error?.code ?? "");
}
EOF
BACKUP_TARGET="$TMP_ROOT/npm-root/openclaw/dist/backup-create-fixture.mjs"
python3 - "$BACKUP_TARGET" <<'PY_BACKUP_FIXTURE'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text(
    'import { t as hasErrnoCode } from "./errno.mjs";\n'
    'function removePreparedBackupArchive(prepared) {\n'
    '\tlet currentIdentity;\n'
    '\ttry {\n'
    '\t\tcurrentIdentity = fs.lstatSync(prepared.archivePath);\n'
    '\t} catch {\n'
    '\t\treturn false;\n'
    '\t}\n'
    '\tif (!currentIdentity.isFile()) return false;\n'
    '}\n'
    'async function publishPreparedBackupArchive(params) {\n'
    '\tconst publication = await publishFileExclusive({\n'
    '\t\tsourcePath: prepared.archivePath,\n'
    '\t\ttargetPath: plan.canonicalOutputPath,\n'
    '\t\tstrategy: "link-required",\n'
    '\t\tonSyncFailure: "preserve"\n'
    '\t});\n'
    '\tif (isHardlinkFallbackError(error)) throw new Error(`Atomic backup publication requires hard-link support in ${plan.requestedParentPath}.`);\n'
    '}\n'
)
PY_BACKUP_FIXTURE
PATH="$TMP_ROOT/bin:$PATH" PREFIX="/data/data/com.termux/files/usr" bash "$PATCH" >/dev/null
grep -Fq 'HARDLINK_FALLBACK_CODES = new Set(["EACCES", "EPERM"' "$FSSAFE_TARGET"
grep -Fq 'NATIVE_COPY_FALLBACK_CODES = new Set(["EACCES", "EINVAL"' "$FSSAFE_TARGET"
grep -Fq 'strategy: "rename-noreplace"' "$BACKUP_TARGET"
grep -Fq 'return hasErrnoCode(error, "ENOENT");' "$BACKUP_TARGET"
grep -Fq 'Atomic backup publication requires atomic no-replace rename support' "$BACKUP_TARGET"
! grep -Fq 'strategy: "link-required"' "$BACKUP_TARGET"
node --input-type=module - "$FSSAFE_TARGET" <<'NODE'
const target=process.argv[2];
const m=await import('file://'+target+'?v='+Date.now());
if(!m.isHardlinkFallbackError({code:'EACCES'})) throw new Error('EACCES hardlink fallback missing');
if(!m.isNativeCopyFallbackError({code:'EACCES'})) throw new Error('EACCES native-copy fallback missing');
if(m.isHardlinkFallbackError({code:'EEXIST'})) throw new Error('collision must remain terminal');
NODE
# Idempotence and no duplicate policy entries.
PATH="$TMP_ROOT/bin:$PATH" PREFIX="/data/data/com.termux/files/usr" bash "$PATCH" >/dev/null
test "$(grep -Fc 'HARDLINK_FALLBACK_CODES = new Set(["EACCES",' "$FSSAFE_TARGET")" -eq 1
test "$(grep -Fc 'NATIVE_COPY_FALLBACK_CODES = new Set(["EACCES",' "$FSSAFE_TARGET")" -eq 1
test "$(grep -Fc 'strategy: "rename-noreplace"' "$BACKUP_TARGET")" -eq 1
test "$(grep -Fc 'return hasErrnoCode(error, "ENOENT");' "$BACKUP_TARGET")" -eq 1
# Kernel no-replace semantics: target collision preserves both generations.
PROBE="$TMP_ROOT/rename-probe"; mkdir -m 700 "$PROBE"; printf 'v1' >"$PROBE/source"
python3 - "$PROBE/source" "$PROBE/target" <<'PY_RENAME_PROBE'
import ctypes,errno,os,sys
src,dst=sys.argv[1:]
libc=ctypes.CDLL(None,use_errno=True); fn=getattr(libc,'renameat2',None)
if fn is None: raise SystemExit('renameat2 unavailable')
fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
fn.restype=ctypes.c_int
if fn(-100,os.fsencode(src),-100,os.fsencode(dst),1)!=0:
    e=ctypes.get_errno(); raise OSError(e,os.strerror(e))
open(src,'w').write('v2')
if fn(-100,os.fsencode(src),-100,os.fsencode(dst),1)==0: raise SystemExit('collision overwrote target')
e=ctypes.get_errno()
if e!=errno.EEXIST: raise OSError(e,os.strerror(e))
if open(dst).read()!='v1' or open(src).read()!='v2': raise SystemExit('generation preservation failed')
PY_RENAME_PROBE
echo "openclaw backup publication compatibility: PASS"
