#!/usr/bin/env python3
"""Memory recall worker keep-alive: pinned existing compatibility owner on the captured public SDK module."""
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
MANIFEST = json.loads(OWNER.with_name("memory-retrieval-warm.json").read_text())
FIXTURE = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-31-memory-retrieval-warm"


class MemoryRetrievalWarm(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "dist").mkdir()
        (self.root / "package.json").write_text('{"version":"2026.9.6"}')
        for item in MANIFEST["files"]:
            raw = gzip.decompress((FIXTURE / "compat" / (Path(item["path"]).name + ".gz")).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item["original"])
            (self.root / item["path"]).write_bytes(raw)

    def cli(self, mode):
        return subprocess.run([sys.executable, str(OWNER), "--patch-set", "memory-retrieval-warm",
                               "--openclaw-root", str(self.root), "--" + mode], capture_output=True, text=True)

    def snapshot(self):
        return {item["path"]: (self.root / item["path"]).read_bytes() for item in MANIFEST["files"]}

    def module(self):
        return (self.root / MANIFEST["files"][0]["path"]).read_text()

    def test_captured_module_is_the_s24_and_npm_original(self):
        measured = json.loads((FIXTURE / "measurements.json").read_text())
        self.assertEqual(measured["module"]["sha256"], MANIFEST["files"][0]["original"])
        self.assertEqual(measured["module"]["npm_sha256"], MANIFEST["files"][0]["original"])
        self.assertEqual(measured["openclaw_version"], MANIFEST["package_version"])

    def test_only_the_recall_pool_gets_the_keep_alive(self):
        self.assertEqual(self.cli("apply").returncode, 0)
        text = self.module()
        retrieval = text[text.index("const retrieval = new WorkerTaskPool({"):text.index("const indexing = new WorkerTaskPool({")]
        indexing = text[text.index("const indexing = new WorkerTaskPool({"):text.index("async function runMemoryIndexState")]
        self.assertIn("idleTimeoutMs: 18e5", retrieval)
        self.assertNotIn("idleTimeoutMs", indexing)
        self.assertEqual(text.count("idleTimeoutMs"), 1)
        node = shutil.which("node")
        if node:
            checked = subprocess.run([node, "--check", str(self.root / MANIFEST["files"][0]["path"])], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_captured_set_atomic_idempotent_and_reversible(self):
        original = self.snapshot()
        self.assertNotEqual(self.cli("check").returncode, 0)
        for mode in ("apply", "check", "apply"):
            result = self.cli(mode)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('"unchanged"', self.cli("apply").stdout)
        for item in MANIFEST["files"]:
            self.assertEqual(hashlib.sha256((self.root / item["path"]).read_bytes()).hexdigest(), item["patched"])
        self.assertEqual(self.cli("rollback").returncode, 0)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.cli("rollback").returncode, 0)

    def test_unknown_module_refuses_before_write(self):
        target = self.root / MANIFEST["files"][0]["path"]
        target.write_bytes(target.read_bytes() + b"// authored drift\n")
        original = self.snapshot()
        result = self.cli("apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported_module_hash", result.stdout)
        self.assertEqual(self.snapshot(), original)

    def test_unsupported_version_refuses_without_write(self):
        original = self.snapshot()
        (self.root / "package.json").write_text('{"version":"2026.10.9"}')
        result = self.cli("apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported_package_version", result.stdout)
        self.assertEqual(self.snapshot(), original)

    def test_deployment_check_and_restart_share_the_owner(self):
        sync = (HERE / "runtime-sync.sh").read_text()
        self.assertIn("--patch-set memory-retrieval-warm --check", sync)
        self.assertIn("openclaw:memory_retrieval_warm", sync)
        self.assertIn("--patch-set memory-retrieval-warm --apply) || fail memory_retrieval_warm_refused", sync)
        self.assertIn('[[ "$memory_patch" == *\'"applied"\'* ]]', sync)
        self.assertIn("--patch-set memory-retrieval-warm", (HERE / "gateway-start.sh").read_text())
        self.assertIn("--patch-set memory-retrieval-warm --rollback", (HERE / "companion-deploy.sh").read_text())

    def test_deploy_rollback_undoes_a_manifest_the_previous_checkout_does_not_own(self):
        source = (HERE / "companion-deploy.sh").read_text()
        start = source.index("  # The memory recall keep-alive set")
        block = source[start:source.index('  if [ -f "$ROOT/openclaw-compat/agent-exec-auth-scope.json" ]', start)]
        repo = self.root / "checkout"
        target = repo / "installer/termux-lite/openclaw-compat"
        target.mkdir(parents=True)
        def git(*args):
            return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
        git("init", "-q")
        (target / "README").write_text("previous checkout without the set\n")
        git("add", "-A")
        git("-c", "user.name=Authored test", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "previous")
        previous = git("rev-parse", "HEAD")
        marker = self.root / "patch-action.txt"
        (target / OWNER.name).write_text("from pathlib import Path\nimport os,sys\nPath(os.environ['PATCH_MARKER']).write_text(' '.join(sys.argv[1:]))\n")
        env = {**os.environ, "ROOT": str(target.parent), "previous": previous, "PATCH_MARKER": str(marker), "log": str(self.root / "guard.log")}
        run = lambda: subprocess.run(["bash", "-c", block], cwd=repo, env=env, capture_output=True, text=True)
        self.assertEqual(run().returncode, 0)
        self.assertFalse(marker.exists(), "no manifest in the candidate, nothing to undo")
        (target / "memory-retrieval-warm.json").write_text('{"version":"candidate"}')
        result = run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(marker.read_text(), "--patch-set memory-retrieval-warm --rollback")
        marker.unlink()
        git("add", "-A")
        git("-c", "user.name=Authored test", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "owns it")
        env["previous"] = git("rev-parse", "HEAD")
        self.assertEqual(run().returncode, 0)
        self.assertFalse(marker.exists(), "a previous checkout owning the same manifest keeps the patch")

    def test_gateway_follows_checkout_ownership_then_rolls_back_the_old_release(self):
        source = (HERE / "gateway-start.sh").read_text()
        block = source[source.index("MEMORY_PATCH_DIR="):source.index('echo "[lite] Starting')]
        checkout, release = self.root / "checkout", self.root / "release"
        target = checkout / "installer/termux-lite/openclaw-compat"
        for directory in (target, release / "openclaw-compat"):
            directory.mkdir(parents=True)
            (directory / "memory-retrieval-warm.json").write_text("{}")
            (directory / OWNER.name).write_text("import sys\nprint(sys.argv[-1], file=sys.stderr)\n")
        env = {**os.environ, "CLAW_CORE_REPO": str(checkout), "SCRIPT_DIR": str(release)}
        applied = subprocess.run(["bash", "-c", block], env=env, capture_output=True, text=True)
        self.assertEqual(applied.returncode, 0)
        self.assertIn("--apply", applied.stderr)
        (target / "memory-retrieval-warm.json").unlink()
        restored = subprocess.run(["bash", "-c", block], env=env, capture_output=True, text=True)
        self.assertEqual(restored.returncode, 0)
        self.assertIn("--rollback", restored.stderr)


if __name__ == "__main__":
    unittest.main()
