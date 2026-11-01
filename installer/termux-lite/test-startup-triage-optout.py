#!/usr/bin/env python3
"""startup-triage-optout: explicit opt-out of OpenClaw's automatic Gateway startup triage (2026.9.6 and 2026.10.9).

Pinned npm public modules (S24 production 2026.9.6 and isolated 2026.10.9 candidate: same sha256), the existing
patch owner, the exact public function bodies in a VM, and the gateway-start/runtime-sync/deploy wiring."""
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
MANIFEST = json.loads(OWNER.with_name("startup-triage-optout.json").read_text())
FIXTURES = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures"
HARNESS = FIXTURES / "openclaw-2026.10.9-compat/startup-triage-optout-harness.cjs"
VERSIONS = {
    "2026.9.6": {"files": MANIFEST["files"], "dir": "openclaw-2026.9.6-compat",
                 "run": "run-S_R0Bn7l.mjs", "stub": "triage-failure-B_xmAewo.mjs", "module": "triage-failure-BI1ymYSt.mjs"},
    "2026.10.9": {"files": MANIFEST["packages"]["2026.10.9"]["files"], "dir": "openclaw-2026.10.9-compat",
                  "run": "run-HO6sETAH.mjs", "stub": "triage-failure-8uvnbYn8.mjs", "module": "triage-failure-DoR3aje_.mjs"},
}
# sha256 read on the S24 on 01/11/2026 (read-only): production 2026.9.6 and the isolated 2026.10.9 candidate.
S24_ORIGINALS = {
    "2026.9.6": "79f504495127a59f632c62c67e70575c41a1c55df122996fd928a497d29afac1",
    "2026.10.9": "a19382f04ad71666a75e3c58c22b0d55b8e1496dbcfdb066ed3908003e8ca746",
}


def node_binary(override):
    if not override:
        return "node"
    candidate = Path(override)
    return str(candidate / "node") if candidate.is_dir() else str(candidate)


NODE = node_binary(os.environ.get("LOCALCI_NODE26_BIN"))


def fixture(version, name):
    return gzip.decompress((FIXTURES / VERSIONS[version]["dir"] / (name + ".gz")).read_bytes())


class StartupTriageOptOut(unittest.TestCase):
    def prepare(self, version):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "dist").mkdir()
        (root / "package.json").write_text('{"version":"%s"}' % version)
        for item in VERSIONS[version]["files"]:
            raw = fixture(version, Path(item["path"]).name)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item["original"])
            (root / item["path"]).write_bytes(raw)
        return root

    def cli(self, root, mode):
        return subprocess.run([sys.executable, str(OWNER), "--patch-set", "startup-triage-optout",
                               "--openclaw-root", str(root), "--" + mode], capture_output=True, text=True, timeout=10)

    def test_pinned_originals_are_the_s24_modules(self):
        for version, expected in S24_ORIGINALS.items():
            (item,) = VERSIONS[version]["files"]
            self.assertEqual(item["path"], "dist/" + VERSIONS[version]["module"])
            self.assertEqual(item["original"], expected, version)

    def test_each_variant_applies_atomically_idempotently_and_reverses(self):
        for version in VERSIONS:
            with self.subTest(version=version):
                root = self.prepare(version)
                (item,) = VERSIONS[version]["files"]
                module = root / item["path"]
                original = module.read_bytes()
                self.assertNotEqual(self.cli(root, "check").returncode, 0)
                for mode in ("apply", "check", "apply"):
                    result = self.cli(root, mode)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(hashlib.sha256(module.read_bytes()).hexdigest(), item["patched"])
                self.assertEqual(json.loads(self.cli(root, "rollback").stdout)["state"], "rolled_back")
                self.assertEqual(module.read_bytes(), original)
                self.assertEqual(json.loads(self.cli(root, "rollback").stdout)["state"], "unchanged")

    def test_unknown_hash_or_version_refuses_before_any_write(self):
        for version in VERSIONS:
            with self.subTest(version=version):
                root = self.prepare(version)
                module = root / VERSIONS[version]["files"][0]["path"]
                module.write_bytes(module.read_bytes() + b"// authored drift\n")
                drifted = module.read_bytes()
                result = self.cli(root, "apply")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unsupported_module_hash", result.stdout)
                self.assertEqual(module.read_bytes(), drifted)
                (root / "package.json").write_text('{"version":"2026.10.1"}')
                self.assertIn("unsupported_package_version", self.cli(root, "apply").stdout)
                self.assertEqual(module.read_bytes(), drifted)

    def test_guard_in_vm_skips_every_triage_effect_only_when_opted_out(self):
        launched = ["signal-bridge", "package-root", "entrypoint", "fresh-process:gateway-startup", "bridge-disposed"]
        for version in VERSIONS:
            with self.subTest(version=version):
                root = self.prepare(version)
                module = root / VERSIONS[version]["files"][0]["path"]
                completed = "completed" if version == "2026.10.9" else None
                runs = {}
                for staged in (False, True):
                    if staged:
                        self.assertEqual(self.cli(root, "apply").returncode, 0)
                    result = subprocess.run([NODE, str(HARNESS), str(module)], capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    runs[staged] = json.loads(result.stdout)
                    check = subprocess.run([NODE, "--check", str(module)], capture_output=True, text=True, timeout=10)
                    self.assertEqual(check.returncode, 0, check.stderr)
                original, patched = runs[False], runs[True]
                # Original code: the variable means nothing, the fresh triage process is always reached.
                self.assertEqual(original["offStartup"]["effects"], launched)
                self.assertFalse(original["offStartup"]["optOutLogged"])
                # Opted out: no signal bridge, package lookup, entrypoint, claim or fresh process; one log line.
                self.assertEqual(patched["offStartup"], {"returned": None, "effects": [], "optOutLogged": True,
                                                          "shellRestored": True})
                # Not opted out, another value, or an update failure: exactly the original behaviour.
                for case in ("unsetStartup", "otherValueStartup", "offUpdate"):
                    self.assertEqual(patched[case], original[case], case)
                self.assertEqual(patched["unsetStartup"]["returned"], completed)
                self.assertIn("fresh-process:update", patched["offUpdate"]["effects"])

    def test_restart_and_final_startup_paths_both_reach_the_guarded_function(self):
        for version, spec in VERSIONS.items():
            with self.subTest(version=version):
                run = fixture(version, spec["run"]).decode()
                stub = fixture(version, spec["stub"]).decode()
                # The stub only re-exports the patched module's function.
                self.assertEqual(stub.strip(), 'import { t as triageAfterFailure } from "./%s";\nexport { triageAfterFailure };'
                                 % spec["module"])
                self.assertEqual(run.count("triageAfterFailure("), 1)
                self.assertIn('triage = await import("./%s");' % spec["stub"], run)
                self.assertRegex(run, r"await triage\.triageAfterFailure\(runtime, \{\n\t\tkind: \"gateway-startup\",")
                self.assertEqual(run.count("triageGatewayStartupFailure(defaultRuntime, error, signal)"), 1)
                # In-process restart failure and final startup failure use the same closure.
                self.assertIn("onRestartStartupFailure: triageStartupFailure,", run)
                self.assertIn("await triageStartupFailure(err);", run)

    def test_restart_recovery_awaits_manual_recovery_when_opted_out(self):
        run = fixture("2026.10.9", "run-HO6sETAH.mjs").decode()
        start = run.index("function createGatewayRestartRecovery(")
        body = run[start:run.index("\n}\n", start) + 2]
        script = (
            "const vm = require('node:vm'); const logs = [];\n"
            "const sandbox = {Promise, AbortController, Error, String, process: {platform: 'android'},\n"
            "  formatErrorMessage: (e) => String(e && e.message || e), formatCliCommand: (c) => c};\n"
            "vm.createContext(sandbox); vm.runInContext(process.argv[1], sandbox);\n"
            "const logger = {info: (m) => logs.push(m), error: (m) => logs.push(m)};\n"
            "const recovery = sandbox.createGatewayRestartRecovery({onRestartStartupFailure: async () => undefined}, logger, null);\n"
            "recovery.attempt(new Error('fixture')).then((retry) => { recovery.reportManualRecovery();\n"
            "  process.stdout.write(JSON.stringify({retry, logs})); });\n")
        result = subprocess.run([NODE, "-e", script, body], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        outcome = json.loads(result.stdout)
        self.assertIs(outcome["retry"], False)
        self.assertIn("Automatic triage did not complete a repair; awaiting manual recovery.", outcome["logs"])
        self.assertTrue(any(line.startswith("Process will stay alive for manual recovery.") for line in outcome["logs"]))

    def test_variable_is_exported_by_gateway_start_only_after_a_verified_apply(self):
        source = (HERE / "gateway-start.sh").read_text()
        block = source[source.index("TRIAGE_PATCH_DIR="):source.index('echo "[lite] Starting')]
        self.assertEqual(source.count("OPENCLAW_STARTUP_TRIAGE"), 1)
        self.assertLess(source.index("export OPENCLAW_STARTUP_TRIAGE=off"), source.index("exec openclaw gateway"))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        checkout, release = base / "checkout", base / "release"
        target = checkout / "installer/termux-lite/openclaw-compat"
        owner = ("import os,sys\nmode=sys.argv[-1]\nprint(mode, file=sys.stderr)\n"
                 "sys.exit(0 if os.environ.get('STUB_'+mode[2:].upper(),'ok')=='ok' else 1)\n")
        for directory in (target, release / "openclaw-compat"):
            directory.mkdir(parents=True)
            (directory / "startup-triage-optout.json").write_text("{}")
            (directory / OWNER.name).write_text(owner)
        probe = block + '\nprintf "TRIAGE=%s\\n" "${OPENCLAW_STARTUP_TRIAGE:-unset}"\n'

        def start(**stub):
            env = {k: v for k, v in os.environ.items() if k != "OPENCLAW_STARTUP_TRIAGE"}
            env.update({"CLAW_CORE_REPO": str(checkout), "SCRIPT_DIR": str(release)}, **stub)
            return subprocess.run(["bash", "-c", "set -euo pipefail\n" + probe], env=env, capture_output=True, text=True)

        applied = start()
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertIn("--apply", applied.stderr)
        self.assertIn("TRIAGE=off", applied.stdout)
        refused = start(STUB_APPLY="refused", STUB_CHECK="drift")
        self.assertEqual(refused.returncode, 0, "an unsupported patch never stops the start")
        self.assertIn("startup triage opt-out patch unsupported", refused.stderr)
        self.assertIn("TRIAGE=unset", refused.stdout)
        (target / "startup-triage-optout.json").unlink()
        restored = start()
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertIn("--rollback", restored.stderr)
        self.assertIn("TRIAGE=unset", restored.stdout)

    def test_deploy_sync_and_rollback_share_the_owner(self):
        sync = (HERE / "runtime-sync.sh").read_text()
        self.assertIn("--patch-set startup-triage-optout --check >/dev/null 2>&1 || drift+=(openclaw:startup_triage_optout)", sync)
        self.assertIn("--patch-set startup-triage-optout --apply) || fail startup_triage_optout_refused", sync)
        self.assertIn('[[ "$triage_patch" == *\'"applied"\'* ]]', sync)
        deploy = (HERE / "companion-deploy.sh").read_text()
        self.assertIn("--patch-set startup-triage-optout --rollback", deploy)
        self.assertIn("startup_triage_optout_rollback_failed", deploy)
        self.assertIn('"startup-triage-optout"', OWNER.read_text())

    def test_import_guard_covers_both_variants(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("compat_imports", HERE / "test-openclaw-compat-imports.py")
        imports = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(imports)
        variants = dict(imports.variants(MANIFEST))
        self.assertEqual(set(variants), set(VERSIONS))
        for version, entries in variants.items():
            self.assertIn(version, imports.SOURCES)
            self.assertIn(VERSIONS[version]["dir"], imports.SOURCES[version])
            for before, after in entries[0]["replacements"]:
                self.assertEqual(imports.introduced(before, after), [])
            self.assertEqual(imports.check_variant("startup-triage-optout", version, entries), [])

    def test_set_is_disjoint_and_adds_only_the_guard(self):
        ours = {item["path"] for spec in VERSIONS.values() for item in spec["files"]}
        for path in OWNER.parent.glob("*.json"):
            if path.name == "startup-triage-optout.json":
                continue
            other = json.loads(path.read_text())
            theirs = {item["path"] for item in other.get("files", [])}
            for chosen in (other.get("packages") or {}).values():
                theirs |= {item["path"] for item in chosen["files"]}
            self.assertFalse(ours & theirs, path.name)
        for spec in VERSIONS.values():
            (item,) = spec["files"]
            ((before, after),) = item["replacements"]
            added = after.replace(before.split("\n")[0] + "\n", "", 1).replace(before.split("\n")[1], "", 1)
            self.assertIn('failure.kind === "gateway-startup" && process.env.OPENCLAW_STARTUP_TRIAGE === "off"', added)
            for forbidden in ("import", "spawn", "require(", "setTimeout", "fs."):
                self.assertNotIn(forbidden, added)


if __name__ == "__main__":
    unittest.main()
