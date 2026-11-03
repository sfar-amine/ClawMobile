#!/usr/bin/env python3
"""One checkout owns each compatibility patch for every pinned OpenClaw version (2026.9.6 and 2026.10.9).

The 2026.10.9 sets run on the public npm modules captured under fixtures/openclaw-2026.10.9-compat (identical
to the candidate installed on the S24, see its README). Same owner, same atomic/reversible contract as the
2026.9.6 sets; the version selects the set, an unknown version is refused before any write."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
COMPAT = HERE / "openclaw-compat"
OWNER = COMPAT / "whatsapp-network-recovery.py"
FIXTURE = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures/openclaw-2026.10.9-compat"
VERSION = "2026.10.9"
SETS = ("memory-retrieval-warm", "native-turn-provenance", "agent-exec-auth-scope", "model-flow-selection", "android-fs-compat",
        "whatsapp-network-recovery")


def manifest(name):
    return json.loads((COMPAT / f"{name}.json").read_text())


class Variants(unittest.TestCase):
    def root(self, name, version=VERSION):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "package.json").write_text(json.dumps({"version": version}))
        # The WhatsApp plugin is its own npm package, installed beside OpenClaw at the same version.
        (root / "whatsapp").mkdir()
        (root / "whatsapp/package.json").write_text(json.dumps({"version": version}))
        for item in manifest(name)["packages"][VERSION]["files"]:
            raw = gzip.decompress((FIXTURE / (Path(item["path"]).name + ".gz")).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item["original"], item["path"])
            target = self.module(root, item)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        return root

    @staticmethod
    def module(root, item):
        return (root / "whatsapp" if item["root"] == "whatsapp" else root) / item["path"]

    def cli(self, name, root, mode):
        return subprocess.run([sys.executable, str(OWNER), "--patch-set", name, "--openclaw-root", str(root),
                               "--whatsapp-root", str(root / "whatsapp"), "--" + mode], capture_output=True, text=True)

    def snapshot(self, name, root):
        return {item["path"]: self.module(root, item).read_bytes() for item in manifest(name)["packages"][VERSION]["files"]}

    def test_every_variant_applies_atomically_idempotently_and_reverses(self):
        for name in SETS:
            with self.subTest(name):
                root = self.root(name)
                original = self.snapshot(name, root)
                self.assertNotEqual(self.cli(name, root, "check").returncode, 0)
                for mode in ("apply", "check"):
                    result = self.cli(name, root, mode)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('"unchanged"', self.cli(name, root, "apply").stdout)
                for item in manifest(name)["packages"][VERSION]["files"]:
                    self.assertEqual(hashlib.sha256(self.module(root, item).read_bytes()).hexdigest(), item["patched"])
                self.assertEqual(self.cli(name, root, "rollback").returncode, 0)
                self.assertEqual(self.snapshot(name, root), original)

    def test_candidate_patched_with_a_pinned_predecessor_upgrades_and_rolls_back(self):
        """S24 rehearsal 01/11: a candidate already patched with a broken 2026.10.9 variant moves to the fixed one."""
        upgraded = []
        for name in SETS:
            for index, item in enumerate(manifest(name)["packages"][VERSION]["files"]):
                for previous in item.get("predecessors", []):
                    with self.subTest(name=name, path=item["path"], predecessor=previous["patched"][:8]):
                        root = self.root(name)
                        original = self.snapshot(name, root)
                        target = self.module(root, item)
                        text = target.read_text()
                        for before, after in previous["replacements"]:
                            self.assertEqual(text.count(before), 1)
                            text = text.replace(before, after)
                        target.write_text(text)
                        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), previous["patched"])
                        self.assertNotEqual(self.cli(name, root, "check").returncode, 0)
                        result = self.cli(name, root, "apply")
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        for entry in manifest(name)["packages"][VERSION]["files"]:
                            self.assertEqual(hashlib.sha256(self.module(root, entry).read_bytes()).hexdigest(), entry["patched"])
                        self.assertEqual(self.cli(name, root, "check").returncode, 0)
                        # Rollback from the predecessor itself restores the published bytes too.
                        target.write_text(text)
                        self.assertEqual(self.cli(name, root, "rollback").returncode, 0)
                        self.assertEqual(self.snapshot(name, root), original)
                        upgraded.append((name, item["path"]))
        self.assertIn(("agent-exec-auth-scope", "dist/runtime-fLuYb9ac.mjs"), upgraded)

    def test_agent_exec_variant_imports_the_scoped_env_owner_of_this_build(self):
        item = manifest("agent-exec-auth-scope")["packages"][VERSION]["files"][0]
        root = self.root("agent-exec-auth-scope")
        self.assertEqual(self.cli("agent-exec-auth-scope", root, "apply").returncode, 0)
        text = self.module(root, item).read_text()
        self.assertIn('import { s as getScopedAuthProfileEnv } from "./store-C7nkCeF3.mjs";', text)
        self.assertNotIn("store-CGYBYVbs", text)
        store = gzip.decompress((FIXTURE / "store-C7nkCeF3.mjs.gz").read_bytes()).decode()
        exports = store[store.rindex("export {"):]
        self.assertIn("getScopedAuthProfileEnv as s,", exports)
        self.assertIn("getScopedSharedAuthStore as c,", exports, "the 2026.9.6 letter names another function here")
        self.assertFalse((FIXTURE / "store-CGYBYVbs.mjs.gz").exists())

    def test_guarded_sync_copy_copies_when_android_refuses_the_clone(self):
        """Runs the published copyRootFileSync of @openclaw/fs-safe 0.26.0 (OpenClaw 2026.10.9), original and patched,
        with its sibling modules replaced by plain-fs stand-ins and a native helper that refuses FICLONE with EACCES
        as the S24 kernel does; the plugin loader calls it with clone "auto" for sources above 64 KiB."""
        node = shutil.which("node")
        if not node:
            self.skipTest("node unavailable")
        item = next(entry for entry in manifest("android-fs-compat")["packages"][VERSION]["files"]
                    if entry["path"].endswith("/copy-root-file-sync.js"))
        published = gzip.decompress((FIXTURE / "copy-root-file-sync.js.gz").read_bytes())
        self.assertEqual(hashlib.sha256(published).hexdigest(), item["original"])
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        work = Path(temporary.name)
        stubs = {
            "byte-budget.js": "export const normalizeMaxBytes = (value) => value;",
            "copy-path-admission.js": "import path from 'node:path';\nexport function createCopyPathAdmissionCache() { return { admit(p) {"
                " return { path: p.absolutePath, rootCanonicalPath: p.rootPath, assertCurrent() {},"
                " parent: { realPath: path.dirname(p.absolutePath), stat: { dev: 0, ino: 0 } } }; }, clear() {} }; }",
            # Same policy as the published copy-policy.js of fs-safe 0.26.0.
            "copy-policy.js": "import { FsSafeError } from './errors.js';\nexport function resolveCopyCloneMode(mode, defaultMode) {"
                " const policy = mode === undefined ? defaultMode : mode; if (policy !== 'auto' && policy !== 'always' && policy !== 'never')"
                " throw new FsSafeError('invalid-path', 'copy clone policy must be auto, always, or never'); return policy; }",
            "create.js": "export function createFileWithAdmissionSync() { throw new Error('unexpected JS copy path'); }",
            "create-owned-file.js": "import fs from 'node:fs';\nexport const ownFileDescriptorSync = (fd) => ({ fd, close() { fs.closeSync(fd); } });",
            "creation-boundary.js": "export const creationAdmissionFromParent = () => ({});\nexport function removeRecordedCreationFileSync() {}",
            "errors.js": "export class FsSafeError extends Error { constructor(code, message, options = {}) {"
                " super(message, { cause: options.cause }); this.code = code; } }",
            "exclusive-create.js": "export function assertExclusiveCreateLeaf() {}",
            "file-handle-transfer.js": "export function copyFileDescriptorSync() { throw new Error('unexpected JS copy path'); }",
            "native-binding.js": "export const captureNativeFdClose = () => undefined;",
            "native.js": "import fs from 'node:fs';\nimport path from 'node:path';\nexport const calls = [];\n"
                "export function getNativeBinding() { return {\n"
                "  copyFileExclusiveSync(sourceFd, parentFd, name, clone) { calls.push(clone);\n"
                "    const target = path.join(globalThis.copyTargetDir, name); const fd = fs.openSync(target, 'wx', 0o600);\n"
                "    if (clone !== 'never') return { fd, method: 'clone', errorCode: 'EACCES', errorMessage: 'FICLONE: permission denied' };\n"
                "    fs.writeFileSync(fd, fs.readFileSync(sourceFd)); return { fd, method: 'copy' }; },\n"
                "  removeStagedFile(parentFd, name) { fs.unlinkSync(path.join(globalThis.copyTargetDir, name)); return 'removed'; } }; }",
            "root-file.js": "import fs from 'node:fs';\nexport const openRootFileSync = (o) => ({ ok: true, fd: fs.openSync(o.absolutePath, 'r') });",
            "root-read-admission.js": "import fs from 'node:fs';\nexport const inspectOpenedPathIdentitySync = (p) => fs.statSync(p, { bigint: true });",
            "staged-directory.js": "import fs from 'node:fs';\nexport const openStagedDirectory = (dir) => ({ fd: fs.openSync(dir, 'r') });",
            "strict-file-identity.js": "export const inspectFileIdentitySync = (inspect) => inspect();",
        }
        imports = sorted(set(re.findall(r'from "\./([^"]+)"', published.decode())))
        self.assertEqual(imports, sorted(stubs), "stand-ins cover exactly the published imports")
        script = "\n".join([
            "import fs from 'node:fs';", "import path from 'node:path';",
            "const [dir, source] = process.argv.slice(1);", "const { copyRootFileSync } = await import(path.join(dir, 'copy-root-file-sync.js'));",
            "const { calls } = await import(path.join(dir, 'native.js'));",
            "const out = {}; let n = 0;",
            "for (const clone of ['auto', 'always', 'never', undefined]) {",
            "  const targetDir = fs.mkdtempSync(path.join(dir, 'target-')); globalThis.copyTargetDir = targetDir; const absolutePath = path.join(targetDir, 'copy-' + n++);",
            "  try { const copied = copyRootFileSync({ source: { rootPath: path.dirname(source), absolutePath: source },",
            "      destination: { rootPath: targetDir, absolutePath }, clone, sourceHardlinks: 'allow' });",
            "    copied.close(); out[String(clone)] = { method: copied.method, same: fs.readFileSync(absolutePath).equals(fs.readFileSync(source)) };",
            "  } catch (error) { out[String(clone)] = { error: error.message, code: error.code, cause: error.cause?.code, left: fs.existsSync(absolutePath) }; }",
            "}",
            "out.calls = calls; console.log(JSON.stringify(out));",
        ])
        source = work / "plugin-source.mjs"
        source.write_bytes(b"// synthetic plugin source above the 64 KiB small-copy limit\n" + b"x" * (70 * 1024))
        results = {}
        for label, data in (("original", published), ("patched", None)):
            module_dir = work / label
            module_dir.mkdir()
            for stub, body in stubs.items():
                (module_dir / stub).write_text(body + "\n")
            (module_dir / "package.json").write_text('{"type": "module"}')
            target = module_dir / "copy-root-file-sync.js"
            target.write_bytes(published)
            if data is None:
                fs_root = work / "root"
                fs_root.mkdir()
                (fs_root / "package.json").write_text(json.dumps({"version": VERSION}))
                for entry in manifest("android-fs-compat")["packages"][VERSION]["files"]:
                    raw = gzip.decompress((FIXTURE / (Path(entry["path"]).name + ".gz")).read_bytes())
                    (fs_root / entry["path"]).parent.mkdir(parents=True, exist_ok=True)
                    (fs_root / entry["path"]).write_bytes(raw)
                result = self.cli("android-fs-compat", fs_root, "apply")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                target.write_bytes((fs_root / item["path"]).read_bytes())
                self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), item["patched"])
            run = subprocess.run([node, "--input-type=module", "-e", script, str(module_dir), str(source)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            results[label] = json.loads(run.stdout)
        original, patched = results["original"], results["patched"]
        # Upstream bytes reproduce the S24 load failure: a refused clone has no fallback in this copy.
        self.assertEqual((original["auto"]["error"], original["auto"]["cause"]), ("guarded synchronous file copy failed", "EACCES"))
        self.assertEqual(original["auto"]["code"], "helper-failed")
        self.assertFalse(original["auto"]["left"], "the refused copy leaves no partial file")
        self.assertEqual(original["calls"], ["auto", "always", "never", "never"])
        # Patched: "auto" copies; an explicit "always" stays strict; "never" and the default are unchanged.
        self.assertEqual(patched["auto"], {"method": "copy", "same": True})
        self.assertEqual((patched["always"]["error"], patched["always"]["cause"]), ("guarded synchronous file copy failed", "EACCES"))
        self.assertEqual(patched["never"], {"method": "copy", "same": True})
        self.assertEqual(patched["undefined"], {"method": "copy", "same": True})
        self.assertEqual(patched["calls"], ["never", "always", "never", "never"])

    def test_secret_egress_ca_finds_termux_openssl(self):
        """S24 rehearsal 01/11: with secrets.egressProxy the 2026.10.9 Gateway stopped at "Secret egress proxy Worker is
        unavailable". The Worker's real error, reproduced on the S24 with the candidate's own modules, is
        `openssl is required to generate secret egress proxy certificates` (ca-D3c9PAvv.mjs, inside withFileLock):
        resolveSystemBin only searches /usr/bin, /bin, /usr/sbin, /sbin, /run/current-system/sw/bin and /snap/bin, and
        Android has openssl only in the Termux prefix. Runs the published CA module, original then patched, with the
        published resolveSystemBin, an Android view of those directories and the real openssl of this machine."""
        node, openssl = shutil.which("node"), shutil.which("openssl")
        if not node or not openssl:
            self.skipTest("node or openssl unavailable")
        item = next(entry for entry in manifest("android-fs-compat")["packages"][VERSION]["files"]
                    if entry["path"] == "dist/ca-D3c9PAvv.mjs")
        published = gzip.decompress((FIXTURE / "ca-D3c9PAvv.mjs.gz").read_bytes())
        resolver = gzip.decompress((FIXTURE / "resolve-system-bin-COKBgJV4.mjs.gz").read_bytes())
        self.assertEqual(hashlib.sha256(published).hexdigest(), item["original"])
        self.assertEqual(hashlib.sha256(resolver).hexdigest(), "0c1f6ad98b9f2ec51f2655baa9aca880f859a462a03caa0fb7492a78af9c9a17")
        termux = "/data/data/com.termux/files/usr/bin"
        stubs = {
            "exec-DdJWnONN.mjs": "import { execFileSync } from 'node:child_process';\nexport async function n(command, args) {"
                f" globalThis.execCalls.push(command); execFileSync(command === '{termux}/openssl' ? globalThis.realOpenssl : command, args,"
                " { stdio: 'ignore' }); return { stdout: '', stderr: '' }; }",
            "keyed-async-queue-CTreGrmR.mjs": "export class t { enqueue(key, task) { return task(); } }",
            "ip-Df-yvQzE.mjs": "import net from 'node:net';\nexport const v = (value) => (net.isIP(value) ? value : null);",
            "file-lock-CkzOvhYo.mjs": "export const s = async (target, options, task) => task();",
            "file-lock-Cl3feKST.mjs": "export {};",
            "map-size-BlrH_CnE.mjs": "export function t(map, max) { for (const key of map.keys()) { if (map.size <= max) break; map.delete(key); } }",
            "windows-install-roots-QtLay04M.mjs": "export const i = () => [];\nexport const n = () => ({ systemRoot: 'C:\\\\Windows' });",
        }
        imports = sorted(set(re.findall(r'from "\./([^"]+)"', published.decode())) | set(re.findall(r'import "\./([^"]+)"', published.decode())))
        self.assertEqual(imports, sorted(set(stubs) - {"map-size-BlrH_CnE.mjs", "windows-install-roots-QtLay04M.mjs"} | {"resolve-system-bin-COKBgJV4.mjs"}))
        self.assertEqual(sorted(re.findall(r'from "\./([^"]+)"', resolver.decode())), ["map-size-BlrH_CnE.mjs", "windows-install-roots-QtLay04M.mjs"])
        script = "\n".join([
            "import fs from 'node:fs';", "import path from 'node:path';", "import { X509Certificate } from 'node:crypto';",
            "const [dir, openssl, certDir] = process.argv.slice(1);",
            f"const TERMUX = '{termux}';",
            # Android: none of the fixed system directories holds openssl; Termux does (mapped to this machine's openssl).
            "const SYSTEM = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/run/current-system/sw/bin', '/snap/bin', '/usr/local/bin']);",
            "const access = fs.accessSync; globalThis.probes = []; globalThis.execCalls = []; globalThis.realOpenssl = openssl;",
            "fs.accessSync = (file, mode) => { if (path.basename(file) === 'openssl') globalThis.probes.push(path.dirname(file));",
            "  if (file === TERMUX + '/openssl') return; if (SYSTEM.has(path.dirname(file))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }",
            "  return access(file, mode); };",
            "const ca = await import(path.join(dir, 'ca-D3c9PAvv.mjs'));",
            "const out = {};",
            "try { const pair = await ca.n(certDir); const cert = new X509Certificate(fs.readFileSync(pair.certPath));",
            "  out.ca = { isCa: cert.ca, subject: cert.subject, key: (fs.statSync(pair.keyPath).mode & 0o777).toString(8) };",
            "  const leaf = await ca.r({ certDir, ca: pair, hostname: 'api.example.test' }); const leafCert = new X509Certificate(leaf.cert);",
            "  out.leaf = { host: leafCert.checkHost('api.example.test'), issuer: leafCert.checkIssued(cert), isCa: leafCert.ca };",
            "} catch (error) { out.error = error.message; }",
            "out.probes = globalThis.probes; out.exec = [...new Set(globalThis.execCalls)]; console.log(JSON.stringify(out));",
        ])
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        work = Path(temporary.name)
        results = {}
        for label in ("original", "patched"):
            module_dir = work / label
            module_dir.mkdir()
            (module_dir / "package.json").write_text('{"type": "module"}')
            for stub, body in stubs.items():
                (module_dir / stub).write_text(body + "\n")
            (module_dir / "resolve-system-bin-COKBgJV4.mjs").write_bytes(resolver)
            target = module_dir / "ca-D3c9PAvv.mjs"
            target.write_bytes(published)
            if label == "patched":
                fs_root = work / "root"
                (fs_root / "dist").mkdir(parents=True)
                (fs_root / "package.json").write_text(json.dumps({"version": VERSION}))
                for entry in manifest("android-fs-compat")["packages"][VERSION]["files"]:
                    raw = gzip.decompress((FIXTURE / (Path(entry["path"]).name + ".gz")).read_bytes())
                    (fs_root / entry["path"]).parent.mkdir(parents=True, exist_ok=True)
                    (fs_root / entry["path"]).write_bytes(raw)
                result = self.cli("android-fs-compat", fs_root, "apply")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                target.write_bytes((fs_root / item["path"]).read_bytes())
                self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), item["patched"])
            cert_dir = work / (label + "-ca")
            run = subprocess.run([node, "--input-type=module", "-e", script, str(module_dir), openssl, str(cert_dir)],
                                 capture_output=True, text=True, timeout=120)
            self.assertEqual(run.returncode, 0, run.stderr)
            results[label] = json.loads(run.stdout)
        original, patched = results["original"], results["patched"]
        # Upstream bytes reproduce the S24 Worker failure, before any certificate work.
        self.assertEqual(original["error"], "openssl is required to generate secret egress proxy certificates")
        self.assertNotIn(termux, original["probes"])
        self.assertEqual(original["exec"], [])
        # Patched: the fixed system directories first, then only the fixed Termux directory (never PATH).
        self.assertNotIn("error", patched)
        self.assertEqual(patched["probes"][-1], termux)
        self.assertEqual(patched["exec"], [termux + "/openssl"])
        self.assertEqual(patched["ca"], {"isCa": True, "subject": "CN=OpenClaw Secret Egress Proxy", "key": "600"})
        self.assertEqual(patched["leaf"], {"host": "api.example.test", "issuer": True, "isCa": False})

    def test_android_set_refuses_an_unknown_ca_module_before_any_write(self):
        root = self.root("android-fs-compat")
        before = self.snapshot("android-fs-compat", root)
        target = root / "dist/ca-D3c9PAvv.mjs"
        target.write_bytes(target.read_bytes().replace(b'resolveSystemBin("openssl");', b'resolveSystemBin("openssl") ;', 1))
        changed = self.snapshot("android-fs-compat", root)
        for mode in ("apply", "rollback", "check"):
            result = self.cli("android-fs-compat", root, mode)
            self.assertNotEqual(result.returncode, 0, mode)
            self.assertIn("unsupported_module_hash:dist/ca-D3c9PAvv.mjs", result.stdout)
            self.assertEqual(self.snapshot("android-fs-compat", root), changed, "no file of the set is written")
        self.assertEqual({k: v for k, v in changed.items() if k != "dist/ca-D3c9PAvv.mjs"},
                         {k: v for k, v in before.items() if k != "dist/ca-D3c9PAvv.mjs"})

    def test_original_pinned_set_is_unchanged_for_2026_9_6(self):
        for name in SETS:
            with self.subTest(name):
                data = manifest(name)
                self.assertEqual(data["package_version"], "2026.9.6")
                # The Android filesystem set has nothing to change on 2026.9.6.
                self.assertEqual(bool(data["files"]), name != "android-fs-compat")
                self.assertEqual(set(data["packages"]), {VERSION})

    def test_unknown_version_refuses_before_any_write(self):
        root = self.root("memory-retrieval-warm", version="2026.10.8")
        before = self.snapshot("memory-retrieval-warm", root)
        result = self.cli("memory-retrieval-warm", root, "apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported_package_version", result.stdout)
        self.assertEqual(self.snapshot("memory-retrieval-warm", root), before)

    def test_patched_modules_parse_and_model_profile_exports_exist(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node unavailable")
        for name in SETS:
            root = self.root(name)
            self.assertEqual(self.cli(name, root, "apply").returncode, 0)
            for item in manifest(name)["packages"][VERSION]["files"]:
                if item["path"].endswith((".mjs", ".js")):
                    checked = subprocess.run([node, "--check", str(self.module(root, item))], capture_output=True, text=True)
                    self.assertEqual(checked.returncode, 0, item["path"] + checked.stderr)
            if name == "model-flow-selection":
                embedded = (root / "dist/embedded-agent-DoEPu8ye.mjs").read_text()
                # The plugin's session metadata owner reads the contract from this chunk on 2026.10.9 (openclawSdkVersions).
                self.assertIn("export { MODEL_PROFILE_CONTRACT_VERSION, applyHookModelProfile, compactEmbeddedAgentSession as n, "
                              "resolveHookModelSelection, runEmbeddedAgent as t };", embedded)
                self.assertEqual(embedded.count("const MODEL_PROFILE_CONTRACT_VERSION = 1;"), 1)
                self.assertIn('profilePluginId: "openclaw-plugin-mobile-ui", selectionStage: "before_runtime"', embedded)
                self.assertIn('import { resolveHookModelSelection } from "./embedded-agent-DoEPu8ye.mjs";',
                              (root / "dist/run-entry-BnMGfzuI.mjs").read_text())
                self.assertIn("runBeforeModelResolveForPlugin", (root / "dist/hooks-CgZHhfMh.mjs").read_text())

    def test_model_flow_candidate_patched_before_the_contract_export_upgrades_and_rolls_back(self):
        """A 2026.10.9 candidate patched by the previous variant (no contract export) upgrades through its original."""
        root = self.root("model-flow-selection")
        original = self.snapshot("model-flow-selection", root)
        entry = next(item for item in manifest("model-flow-selection")["packages"][VERSION]["files"]
                     if item["path"] == "dist/embedded-agent-DoEPu8ye.mjs")
        previous = entry["predecessors"][0]
        self.assertEqual(previous["replacements"], entry["replacements"][:-1])
        target = self.module(root, entry)
        text = target.read_text()
        for before, after in previous["replacements"]:
            text = text.replace(before, after)
        target.write_text(text)
        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), previous["patched"])
        self.assertEqual(self.cli("model-flow-selection", root, "apply").returncode, 0)
        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), entry["patched"])
        self.assertEqual(self.cli("model-flow-selection", root, "check").returncode, 0)
        self.assertEqual(self.cli("model-flow-selection", root, "rollback").returncode, 0)
        self.assertEqual(self.snapshot("model-flow-selection", root), original)

    def test_whatsapp_transport_loss_keeps_slow_retries_after_the_fast_burst(self):
        """Runs the patched 2026.10.9 consumeReconnectAttempt and close path, not a copy of it."""
        node = shutil.which("node")
        if not node:
            self.skipTest("node unavailable")
        root = self.root("whatsapp-network-recovery")
        self.assertEqual(self.cli("whatsapp-network-recovery", root, "apply").returncode, 0)
        text = (root / "whatsapp/dist/.setup/connection-controller-CejM7bhn.mjs").read_text()
        start = text.index("function isRecoverableWhatsAppTransport(")
        helper = text[start:text.index("const LOGGED_OUT_STATUS = 401;", start)]
        body = text[text.index("\tresolveCloseDecision(reason) {"):text.index("\tforceClose(reason) {")]
        self.assertIn("allowSlow: isRecoverableWhatsAppTransport(normalized.statusCode, normalized.error)", body)
        self.assertIn("if (typeof statusCode !== \"number\" && !isRecoverableWhatsAppTransport(statusCode, error)) return null;", body)
        script = "\n".join([
            'const WHATSAPP_WATCHDOG_TIMEOUT_ERROR = "watchdog";',
            "const LOGGED_OUT_STATUS = 401;",
            "const computeBackoff = (policy, attempt) => 1000 * attempt;",
            "const getStatusCode = (error) => error?.status;",
            helper,
            "class Controller {",
            "constructor() { this.reconnectAttempts = 0; this.current = null;",
            "  this.params = { keepAlive: true, heartbeatSeconds: 60, reconnectPolicy: { maxAttempts: 3 } }; }",
            "isStopRequested() { return false; }",
            "isNonRetryableStatus(status) { return status === 440; }",
            "normalizeCloseReason(reason) { return { statusCode: reason.status, error: reason.error, isLoggedOut: !!reason.isLoggedOut }; }",
            body,
            "}",
            "const out = {};",
            "const dns = new Controller();",
            'out.dns = [1, 2, 3, 4, 5, 6].map(() => dns.resolveSetupErrorDecision({ code: "EAI_AGAIN" }));',
            "const unknown = new Controller();",
            "out.unknown = [1, 2, 3].map(() => unknown.resolveCloseDecision({ status: 500 }));",
            "out.loggedOut = new Controller().resolveCloseDecision({ status: 401 });",
            'out.notTransport = new Controller().resolveSetupErrorDecision(new Error("boom"));',
            "console.log(JSON.stringify(out));",
        ])
        run = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        out = json.loads(run.stdout)
        actions = [decision["action"] for decision in out["dns"]]
        self.assertEqual(actions, ["retry"] * 6, "a DNS loss never stops the channel")
        self.assertEqual([d["reconnectAttempts"] for d in out["dns"]], [1, 2, 3, 4, 5, 5], "counter bounded at fast limit + 2")
        for decision, nominal in zip(out["dns"][2:], (60000, 120000, 300000, 300000)):
            self.assertGreaterEqual(decision["delayMs"], min(300000, nominal * 0.8))
            self.assertLessEqual(decision["delayMs"], min(300000, nominal * 1.2))
        self.assertEqual([d["action"] for d in out["unknown"]], ["retry", "retry", "stop"], "other failures keep upstream behaviour")
        self.assertEqual((out["loggedOut"]["action"], out["loggedOut"]["healthState"]), ("stop", "logged-out"))
        self.assertIsNone(out["notTransport"])
        monitor = (root / "whatsapp/dist/.setup/monitor-DVzumwCI.mjs").read_text()
        self.assertIn("healthState: decision.healthState,\n                    retryDelayMs: decision.delayMs\n\t\t\t\t});", monitor)
        self.assertEqual(monitor.count("status.recoveryRetryAt = null;"), 2)

    def test_android_set_is_owned_by_deploy_check_restart_and_rollback(self):
        sync = (HERE / "runtime-sync.sh").read_text()
        self.assertIn("--patch-set android-fs-compat --check", sync)
        self.assertIn("--patch-set android-fs-compat --apply) || fail android_fs_compat_refused", sync)
        self.assertIn('[[ "$android_fs_patch" == *\'"applied"\'* ]]', sync)
        self.assertIn("--patch-set android-fs-compat", (HERE / "gateway-start.sh").read_text())
        source = (HERE / "companion-deploy.sh").read_text()
        start = source.index("  # The Android filesystem set")
        block = source[start:source.index('  if [ -f "$ROOT/openclaw-compat/agent-exec-auth-scope.json" ]', start)]
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        repo = Path(temporary.name) / "checkout"
        target = repo / "installer/termux-lite/openclaw-compat"
        target.mkdir(parents=True)
        def git(*args):
            return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
        git("init", "-q")
        (target / "README").write_text("previous checkout without the set\n")
        git("add", "-A")
        git("-c", "user.name=Authored test", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "previous")
        marker = Path(temporary.name) / "action.txt"
        (target / OWNER.name).write_text("from pathlib import Path\nimport os,sys\nPath(os.environ['PATCH_MARKER']).write_text(' '.join(sys.argv[1:]))\n")
        (target / "android-fs-compat.json").write_text('{"version":"candidate"}')
        import os
        env = {**os.environ, "ROOT": str(target.parent), "previous": git("rev-parse", "HEAD"), "PATCH_MARKER": str(marker),
               "log": str(Path(temporary.name) / "guard.log")}
        result = subprocess.run(["bash", "-c", block], cwd=repo, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(marker.read_text(), "--patch-set android-fs-compat --rollback")


if __name__ == "__main__":
    unittest.main()
