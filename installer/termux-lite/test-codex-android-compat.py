#!/usr/bin/env python3
"""codex-android-compat: Codex hosted web search on the S24 (OpenClaw 2026.10.9, @openclaw/codex 2026.10.9).

Pinned public modules (npm @openclaw/fs-safe 0.26.0 as bundled by OpenClaw 2026.10.9, npm @openclaw/codex 2026.10.9;
same sha256 as read on the S24 on 03/11), the existing patch owner with its new `codex` root, the real ownership
function with and without Android, the gateway-start/runtime-sync/deploy wiring and the codex-termux launcher."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
OWNER = HERE / "openclaw-compat/whatsapp-network-recovery.py"
MANIFEST = json.loads(OWNER.with_name("codex-android-compat.json").read_text())
FIXTURES = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures/openclaw-2026.10.9-compat"
LAUNCHER = HERE / "codex-termux.sh"
# sha256 read on the S24 on 03/11/2026 (originals saved before any change).
S24_ORIGINALS = {
    "node_modules/@openclaw/fs-safe/dist/temp-workspace-ownership.js": "dc3f7d3be66ae6102ab1802445b2038995eb20f04fc1320aa6876fc15b8f863f",
    "node_modules/@openclaw/fs-safe/dist/temp-workspace-child-admission.js": "81d4eb437db0992c90d72b3722ae1d7b0407a9488cff91779ad2701d1eac8391",
    "dist/.setup/bounded-turn-B91suzbV.mjs": "4075c99704da09604a067e4cfe26a17093afd3af5deb298854bea4ae772f1faa",
    "dist/.setup/web-search-provider.runtime-DEBVJch2.mjs": "73e09af8e9807c7076f1e108f800f3c93766aabe19d3e69c87a45e223f43225f",
}
ANDROID_ENV = ("ANDROID_ROOT", "TERMUX_VERSION", "PREFIX")


def node_binary(override):
    if not override:
        return "node"
    candidate = Path(override)
    return str(candidate / "node") if candidate.is_dir() else str(candidate)


NODE = node_binary(os.environ.get("LOCALCI_NODE26_BIN"))


def fixture(path):
    return gzip.decompress((FIXTURES / (Path(path).name + ".gz")).read_bytes())


class CodexAndroidCompat(unittest.TestCase):
    def prepare(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        roots = {"openclaw": base / "openclaw", "codex": base / "state/npm/projects/openclaw-codex-test/node_modules/@openclaw/codex"}
        for root in roots.values():
            root.mkdir(parents=True)
            (root / "package.json").write_text(json.dumps({"version": "2026.10.9"}))
        for item in MANIFEST["files"]:
            target = roots[item["root"]] / item["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            raw = fixture(item["path"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item["original"])
            target.write_bytes(raw)
        return base, roots

    def cli(self, base, roots, mode, discover=False):
        args = [sys.executable, str(OWNER), "--patch-set", "codex-android-compat", "--openclaw-root", str(roots["openclaw"]), "--" + mode]
        env = dict(os.environ, OPENCLAW_STATE_DIR=str(base / "state"))
        if not discover:
            args[4:4] = ["--codex-root", str(roots["codex"])]
        return subprocess.run(args, capture_output=True, text=True, timeout=20, env=env)

    def test_pinned_originals_are_the_s24_modules(self):
        self.assertEqual({item["path"]: item["original"] for item in MANIFEST["files"]}, S24_ORIGINALS)
        self.assertEqual(MANIFEST["package_version"], "2026.10.9")
        self.assertEqual({item["root"] for item in MANIFEST["files"]}, {"openclaw", "codex"})

    def test_applies_atomically_idempotently_and_reverses(self):
        base, roots = self.prepare()
        originals = {item["path"]: (roots[item["root"]] / item["path"]).read_bytes() for item in MANIFEST["files"]}
        self.assertNotEqual(self.cli(base, roots, "check").returncode, 0)
        for mode, state in (("apply", "applied"), ("check", "verified"), ("apply", "unchanged")):
            run = self.cli(base, roots, mode)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(json.loads(run.stdout)["state"], state)
        for item in MANIFEST["files"]:
            self.assertEqual(hashlib.sha256((roots[item["root"]] / item["path"]).read_bytes()).hexdigest(), item["patched"])
        run = self.cli(base, roots, "rollback")
        self.assertEqual(json.loads(run.stdout)["state"], "rolled_back")
        for item in MANIFEST["files"]:
            self.assertEqual((roots[item["root"]] / item["path"]).read_bytes(), originals[item["path"]])

    def test_discovers_the_single_codex_plugin_package(self):
        base, roots = self.prepare()
        run = self.cli(base, roots, "apply", discover=True)
        self.assertEqual(json.loads(run.stdout)["state"], "applied", run.stdout)
        twin = base / "state/npm/projects/other/node_modules/@openclaw/codex"
        twin.mkdir(parents=True)
        run = self.cli(base, roots, "check", discover=True)
        self.assertEqual(json.loads(run.stdout)["reason"], "codex_package_missing_or_ambiguous")

    def test_unknown_module_or_version_is_refused_before_any_write(self):
        base, roots = self.prepare()
        provider = roots["codex"] / "dist/.setup/web-search-provider.runtime-DEBVJch2.mjs"
        provider.write_bytes(provider.read_bytes() + b"\n// drift\n")
        snapshot = {item["path"]: (roots[item["root"]] / item["path"]).read_bytes() for item in MANIFEST["files"]}
        run = self.cli(base, roots, "apply")
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("unsupported_module_hash", run.stdout)
        for item in MANIFEST["files"]:
            self.assertEqual((roots[item["root"]] / item["path"]).read_bytes(), snapshot[item["path"]])
        _, roots2 = self.prepare()
        (roots2["codex"] / "package.json").write_text(json.dumps({"version": "2026.11.1"}))
        run = self.cli(base, roots2, "apply")
        self.assertIn("unsupported_package_version", run.stdout)

    def ownership(self, base, roots, env_extra):
        module = roots["openclaw"] / "node_modules/@openclaw/fs-safe/dist/temp-workspace-ownership.js"
        (module.parent / "package.json").write_text('{"type":"module"}')
        script = ("import { classifyTempWorkspaceOwner as c } from " + json.dumps(module.as_uri()) + ";"
                  "console.log(JSON.stringify([c({uid:1000,gid:1000},10554), c({uid:1000n,gid:1000n},10554),"
                  " c({uid:0,gid:0},10554), c({uid:10554,gid:10554},10554), c({uid:2000,gid:2000},10554)]));")
        env = {k: v for k, v in os.environ.items() if k not in ANDROID_ENV}
        env.update(env_extra)
        run = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def test_system_owner_is_trusted_only_on_android(self):
        base, roots = self.prepare()
        self.assertEqual(self.cli(base, roots, "apply").returncode, 0)
        self.assertEqual(self.ownership(base, roots, {"TERMUX_VERSION": "0.118.3"}), ["root", "root", "root", "user", "foreign"])
        linux = self.ownership(base, roots, {})
        self.assertEqual(linux[2:4], ["root", "user"])
        self.assertNotIn("root", linux[:2])

    def test_patched_modules_parse(self):
        base, roots = self.prepare()
        self.assertEqual(self.cli(base, roots, "apply").returncode, 0)
        for item in MANIFEST["files"]:
            path = roots[item["root"]] / item["path"]
            run = subprocess.run([NODE, "--check", str(path)], capture_output=True, text=True, timeout=20)
            self.assertEqual(run.returncode, 0, item["path"] + run.stderr)

    def test_private_leaf_stays_strict_and_unset_env_keeps_shipped_search(self):
        admission = next(i for i in MANIFEST["files"] if i["path"].endswith("temp-workspace-child-admission.js"))
        after = admission["replacements"][0][1]
        self.assertIn("!privateDirectory &&", after)
        provider = next(i for i in MANIFEST["files"] if i["path"].endswith("web-search-provider.runtime-DEBVJch2.mjs"))
        model_after = provider["replacements"][0][1]
        self.assertIn(': { mode: "live-default" }', model_after)
        timeout_after = provider["replacements"][1][1]
        self.assertIn("|| resolveSearchTimeoutSeconds(ctx.searchConfig)", timeout_after)

    def test_wiring_exports_only_after_a_verified_apply(self):
        start = (HERE / "gateway-start.sh").read_text()
        block = start[start.index("CODEX_PATCH_DIR="):start.index('echo "[lite] Starting OpenClaw Gateway')]
        verified = block.index("--patch-set codex-android-compat --check")
        self.assertLess(verified, block.index("export OPENCLAW_CODEX_APP_SERVER_BIN="))
        self.assertLess(verified, block.index("export OPENCLAW_CODEX_WEB_SEARCH_MODEL="))
        self.assertIn('"$(dirname "$CODEX_PATCH_DIR")/codex-termux.sh"', block)
        self.assertIn("--rollback", block)
        sync = (HERE / "runtime-sync.sh").read_text()
        self.assertIn("--patch-set codex-android-compat --check", sync)
        self.assertIn("codex_patch=$(python3", sync)
        self.assertIn('[[ "$codex_patch" == *\'"applied"\'* ]]', sync)
        deploy = (HERE / "companion-deploy.sh").read_text()
        self.assertIn("--patch-set codex-android-compat --rollback", deploy)
        self.assertIn("codex_android_compat_rollback_failed", deploy)

    def launcher(self, with_proot, resolv_exists=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        binary = base / "state/npm/projects/p/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex"
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\necho REAL \"$@\" SSL=$SSL_CERT_FILE\n")
        binary.chmod(0o755)
        bindir = base / "bin"
        bindir.mkdir()
        prefix = base / "prefix"
        (prefix / "etc/tls").mkdir(parents=True)
        (prefix / "etc/resolv.conf").write_text("nameserver 8.8.8.8\n")
        (prefix / "etc/tls/cert.pem").write_text("x")
        if with_proot:
            proot = bindir / "proot"
            proot.write_text("#!/bin/sh\necho PROOT \"$1\" \"$2\"\nshift 2\nexec \"$@\"\n")
            proot.chmod(0o755)
        env = {"HOME": str(base), "OPENCLAW_STATE_DIR": str(base / "state"), "PREFIX": str(prefix),
               "PATH": f"{bindir}:/usr/bin:/bin"}
        return subprocess.run(["bash", str(LAUNCHER), "app-server", "--x"], capture_output=True, text=True, timeout=20, env=env), prefix

    def test_launcher_binds_termux_dns_and_passes_arguments(self):
        run, prefix = self.launcher(with_proot=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        if Path("/etc/resolv.conf").exists():
            self.assertNotIn("PROOT", run.stdout)
        else:
            self.assertIn(f"PROOT -b {prefix}/etc/resolv.conf:/etc/resolv.conf", run.stdout)
        self.assertIn("REAL app-server --x", run.stdout)
        self.assertIn(f"SSL={prefix}/etc/tls/cert.pem", run.stdout)
        run, _ = self.launcher(with_proot=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertNotIn("PROOT", run.stdout)
        self.assertIn("REAL app-server --x", run.stdout)

    def test_set_is_disjoint_from_the_other_sets(self):
        mine = {(i["root"], i["path"]) for i in MANIFEST["files"]}
        for other in OWNER.parent.glob("*.json"):
            if other.name == "codex-android-compat.json":
                continue
            manifest = json.loads(other.read_text())
            if not isinstance(manifest, dict) or "files" not in manifest:
                continue
            entries = list(manifest.get("files") or [])
            for chosen in (manifest.get("packages") or {}).values():
                entries.extend(chosen.get("files") or [])
            self.assertFalse(mine & {(i["root"], i["path"]) for i in entries}, other.name)


if __name__ == "__main__":
    unittest.main()
