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
                self.assertIn("export { applyHookModelProfile, compactEmbeddedAgentSession as n, resolveHookModelSelection, runEmbeddedAgent as t };", embedded)
                self.assertIn('profilePluginId: "openclaw-plugin-mobile-ui", selectionStage: "before_runtime"', embedded)
                self.assertIn('import { resolveHookModelSelection } from "./embedded-agent-DoEPu8ye.mjs";',
                              (root / "dist/run-entry-BnMGfzuI.mjs").read_text())
                self.assertIn("runBeforeModelResolveForPlugin", (root / "dist/hooks-CgZHhfMh.mjs").read_text())

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
