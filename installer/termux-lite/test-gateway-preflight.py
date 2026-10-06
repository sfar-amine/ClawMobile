#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("gateway_preflight", ROOT / "gateway-preflight.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PluginSchemaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source.json"
        self.installed = self.root / "installed.json"
        self.config = self.root / "openclaw.json"

    def write(self, path, data):
        path.write_text(json.dumps(data))

    def manifest(self, properties):
        return {"configSchema": {"type": "object", "additionalProperties": False,
                                 "properties": properties}}

    def test_detects_repairable_installed_schema_drift(self):
        self.write(self.source, self.manifest({"voiceBargeIn": {"type": "object"}}))
        self.write(self.installed, self.manifest({}))
        self.write(self.config, {"plugins": {"entries": {guard.PLUGIN_ID: {
            "config": {"voiceBargeIn": {"enabled": True}}
        }}}})
        result = guard.plugin_schema_status(self.source, self.installed, self.config)
        self.assertEqual(result["state"], "repairable")
        self.assertEqual(result["missing_installed"], ["voiceBargeIn"])

    def test_missing_installed_manifest_forces_reconciliation(self):
        self.write(self.source, self.manifest({}))
        self.write(self.config, {"plugins": {"entries": {guard.PLUGIN_ID: {"config": {}}}}})
        result = guard.plugin_schema_status(self.source, self.installed, self.config)
        self.assertEqual(result["state"], "repairable")
        self.assertEqual(result["reason"], "installed_manifest_missing")

    def test_refuses_config_unknown_to_canonical_source(self):
        self.write(self.source, self.manifest({}))
        self.write(self.installed, self.manifest({}))
        self.write(self.config, {"plugins": {"entries": {guard.PLUGIN_ID: {
            "config": {"unknownFutureKey": True}
        }}}})
        result = guard.plugin_schema_status(self.source, self.installed, self.config)
        self.assertEqual(result["state"], "unsupported")
        self.assertEqual(result["unsupported"], ["unknownFutureKey"])


class StaleLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / ".openclaw"
        self.config = self.state / "openclaw.json"
        self.proc = self.root / "proc"
        self.proc.mkdir(parents=True)
        self.config.parent.mkdir(parents=True, exist_ok=True)
        self.config.write_text("{}")
        self.lock_dir = self.state / "tmp" / f"openclaw-{os.getuid()}"
        self.lock_dir.mkdir(parents=True)
        self.payload = {
            "pid": 123,
            "ownerId": "owner-a",
            "cronOwnerProjection": "dynamic-default-v1",
            "createdAt": "2020-01-01T00:00:00.000Z",
            "configPath": str(self.config),
            "stateDir": str(self.state),
            "port": 18789,
            "startTime": 100,
        }
        self.config_lock = self.lock_dir / "gateway.deadbeef.lock"
        self.state_lock = self.lock_dir / "gateway.state.lock"
        for p in (self.config_lock, self.state_lock):
            p.write_text(json.dumps(self.payload))
            Path(str(p) + ".sqlite").write_bytes(b"")

    def add_process(self, pid=123, start=100, args=None):
        p = self.proc / str(pid)
        p.mkdir()
        fields = ["S", "1"] + ["0"] * 17 + [str(start)]
        (p / "stat").write_text(f"{pid} (node) " + " ".join(fields))
        args = args or ["openclaw-gateway"]
        (p / "cmdline").write_bytes(("\0".join(args) + "\0").encode())

    def test_orphaned_android_lock_is_quarantined_reversibly(self):
        result = guard.recover_stale_gateway_locks(
            self.state, self.config, 18789, proc_root=self.proc,
            backup_root=self.root / "backups", port_probe=lambda port: False
        )
        self.assertEqual(result["state"], "recovered")
        self.assertFalse(self.config_lock.exists())
        self.assertFalse(self.state_lock.exists())
        backup = Path(result["backup"])
        self.assertTrue((backup / self.config_lock.name).is_file())
        self.assertTrue((backup / self.state_lock.name).is_file())
        self.assertTrue((backup / (self.config_lock.name + ".sqlite")).is_file())

    def test_matching_live_gateway_owner_is_never_reclaimed(self):
        self.add_process()
        result = guard.stale_gateway_lock_status(
            self.state, self.config, 18789, proc_root=self.proc,
            port_probe=lambda port: False
        )
        self.assertEqual(result["state"], "active_owner")

    def test_pid_reuse_with_different_start_identity_is_recoverable(self):
        self.add_process(start=999, args=["unrelated-process"])
        result = guard.stale_gateway_lock_status(
            self.state, self.config, 18789, proc_root=self.proc,
            port_probe=lambda port: False
        )
        self.assertEqual(result["state"], "stale_recoverable")

    def test_listener_blocks_lock_recovery(self):
        result = guard.stale_gateway_lock_status(
            self.state, self.config, 18789, proc_root=self.proc,
            port_probe=lambda port: True
        )
        self.assertEqual(result["state"], "active_listener")


class RunScriptContractTests(unittest.TestCase):
    def test_preflights_precede_gateway_exec(self):
        text=(ROOT/'run.sh').read_text()
        schema=text.index('gateway-preflight.py')
        validate=text.index('openclaw config validate')
        locks=text.rindex('stale-locks')
        gateway=text.rindex('exec openclaw gateway')
        self.assertLess(schema,validate)
        self.assertLess(validate,locks)
        self.assertLess(locks,gateway)
        self.assertIn('refusing automatic deployment',text)
        self.assertIn('Recovered an orphaned Android gateway lock',text)


class CompanionMaintenanceRecoveryContractTests(unittest.TestCase):
    def test_companion_uses_bounded_doctor_repair_for_explicit_maintenance(self):
        text=(ROOT.parent.parent/'openclaw-plugin-mobile-ui/src/companion/openclawGatewayClient.ts').read_text()
        self.assertIn('STARTUP_MAINTENANCE_REPAIR_ATTEMPTS = 2', text)
        self.assertIn('STARTUP_MAINTENANCE_REPAIR_TIMEOUT_S = 60', text)
        self.assertIn('"gateway.maintenance_required"', text)
        self.assertIn('"doctor"', text)
        self.assertIn('"--fix"', text)
        self.assertIn('"--non-interactive"', text)
        self.assertIn('startRuntimeInternal(false)', text)

    def test_companion_fails_closed_when_gateway_ownership_remains(self):
        text=(ROOT.parent.parent/'openclaw-plugin-mobile-ui/src/companion/openclawGatewayClient.ts').read_text()
        self.assertIn('Refusing Doctor repair while gateway process ownership is still present', text)
        self.assertIn('if (childExited)', text)
        self.assertIn('runtimeLogNeedsMaintenance(failedLog.text)', text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
