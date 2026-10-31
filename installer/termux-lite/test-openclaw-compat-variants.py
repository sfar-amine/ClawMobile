#!/usr/bin/env python3
"""One checkout owns each compatibility patch for every pinned OpenClaw version (2026.9.6 and 2026.10.9).

The 2026.10.9 sets run on the public npm modules captured under fixtures/openclaw-2026.10.9-compat (identical
to the candidate installed on the S24, see its README). Same owner, same atomic/reversible contract as the
2026.9.6 sets; the version selects the set, an unknown version is refused before any write."""
import gzip
import hashlib
import json
from pathlib import Path
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
SETS = ("memory-retrieval-warm", "native-turn-provenance", "agent-exec-auth-scope", "model-flow-selection")


def manifest(name):
    return json.loads((COMPAT / f"{name}.json").read_text())


class Variants(unittest.TestCase):
    def root(self, name, version=VERSION):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "package.json").write_text(json.dumps({"version": version}))
        for item in manifest(name)["packages"][VERSION]["files"]:
            raw = gzip.decompress((FIXTURE / (Path(item["path"]).name + ".gz")).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item["original"], item["path"])
            target = root / item["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        return root

    def cli(self, name, root, mode):
        return subprocess.run([sys.executable, str(OWNER), "--patch-set", name, "--openclaw-root", str(root), "--" + mode],
                              capture_output=True, text=True)

    def snapshot(self, name, root):
        return {item["path"]: (root / item["path"]).read_bytes() for item in manifest(name)["packages"][VERSION]["files"]}

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
                    self.assertEqual(hashlib.sha256((root / item["path"]).read_bytes()).hexdigest(), item["patched"])
                self.assertEqual(self.cli(name, root, "rollback").returncode, 0)
                self.assertEqual(self.snapshot(name, root), original)

    def test_original_pinned_set_is_unchanged_for_2026_9_6(self):
        for name in SETS:
            with self.subTest(name):
                data = manifest(name)
                self.assertEqual(data["package_version"], "2026.9.6")
                self.assertTrue(data["files"])
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
                if item["path"].endswith(".mjs"):
                    checked = subprocess.run([node, "--check", str(root / item["path"])], capture_output=True, text=True)
                    self.assertEqual(checked.returncode, 0, item["path"] + checked.stderr)
            if name == "model-flow-selection":
                embedded = (root / "dist/embedded-agent-DoEPu8ye.mjs").read_text()
                self.assertIn("export { applyHookModelProfile, compactEmbeddedAgentSession as n, resolveHookModelSelection, runEmbeddedAgent as t };", embedded)
                self.assertIn('profilePluginId: "openclaw-plugin-mobile-ui", selectionStage: "before_runtime"', embedded)
                self.assertIn('import { resolveHookModelSelection } from "./embedded-agent-DoEPu8ye.mjs";',
                              (root / "dist/run-entry-BnMGfzuI.mjs").read_text())
                self.assertIn("runBeforeModelResolveForPlugin", (root / "dist/hooks-CgZHhfMh.mjs").read_text())


if __name__ == "__main__":
    unittest.main()
