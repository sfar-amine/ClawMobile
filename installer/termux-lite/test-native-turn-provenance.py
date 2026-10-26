#!/usr/bin/env python3
"""Pinned existing compatibility owner on full captured public SDK modules."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
OWNER = HERE / "openclaw-compat/whatsapp-network-recovery.py"
MANIFEST = json.loads(OWNER.with_name("native-turn-provenance.json").read_text())
FIXTURE = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-26-native-sdk/compat"


class NativeTurnProvenance(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "dist").mkdir()
        (self.root / "package.json").write_text('{"version":"2026.9.6"}')
        for item in MANIFEST["files"]:
            raw = gzip.decompress((FIXTURE / (Path(item["path"]).name + ".gz")).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item["original"])
            (self.root / item["path"]).write_bytes(raw)

    def cli(self, mode):
        return subprocess.run([sys.executable, str(OWNER), "--patch-set", "native-turn-provenance",
                               "--openclaw-root", str(self.root), "--" + mode], capture_output=True, text=True)

    def snapshot(self):
        return {item["path"]: (self.root / item["path"]).read_bytes() for item in MANIFEST["files"]}

    def test_captured_set_atomic_idempotent_and_reversible(self):
        original = self.snapshot()
        self.assertNotEqual(self.cli("check").returncode, 0)
        for mode in ("apply", "check", "apply"):
            result = self.cli(mode)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for item in MANIFEST["files"]:
            self.assertEqual(hashlib.sha256((self.root / item["path"]).read_bytes()).hexdigest(), item["patched"])
        self.assertEqual(self.cli("rollback").returncode, 0)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.cli("rollback").returncode, 0)

    def test_late_unknown_module_refuses_before_first_write(self):
        last = self.root / MANIFEST["files"][-1]["path"]
        last.write_bytes(last.read_bytes() + b"// authored drift\n")
        original = self.snapshot()
        result = self.cli("apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported_module_hash", result.stdout)
        self.assertEqual(self.snapshot(), original)

    def test_unsupported_version_refuses_without_write(self):
        original = self.snapshot()
        (self.root / "package.json").write_text('{"version":"2026.10.1"}')
        result = self.cli("apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported_package_version", result.stdout)
        self.assertEqual(self.snapshot(), original)

    def test_deployment_and_rollback_have_the_same_patch_owner(self):
        for name in ("runtime-sync.sh", "gateway-start.sh", "companion-deploy.sh"):
            source = (HERE / name).read_text()
            self.assertIn("--patch-set native-turn-provenance", source)
        sync = (HERE / "runtime-sync.sh").read_text()
        self.assertIn("native_turn_provenance_refused", sync)
        self.assertIn('[[ "$native_patch" == *\'"applied"\'* ]]', sync)

    def test_gateway_follows_checkout_ownership_then_rolls_back_the_old_release(self):
        source = (HERE / "gateway-start.sh").read_text()
        block = source[source.index("NATIVE_PATCH_DIR="):source.index('echo "[lite] Starting')]
        checkout, release = self.root / "checkout", self.root / "release"
        target = checkout / "installer/termux-lite/openclaw-compat"
        for directory in (target, release / "openclaw-compat"):
            directory.mkdir(parents=True)
            (directory / "native-turn-provenance.json").write_text("{}")
            (directory / OWNER.name).write_text("import sys\nprint(sys.argv[-1])\n")
        env = {**os.environ, "CLAW_CORE_REPO": str(checkout), "SCRIPT_DIR": str(release)}
        applied = subprocess.run(["bash", "-c", block], env=env, capture_output=True, text=True)
        self.assertEqual(applied.returncode, 0)
        self.assertIn("--apply", applied.stderr)
        (target / "native-turn-provenance.json").unlink()
        restored = subprocess.run(["bash", "-c", block], env=env, capture_output=True, text=True)
        self.assertEqual(restored.returncode, 0)
        self.assertIn("--rollback", restored.stderr)


if __name__ == "__main__":
    unittest.main()
