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

    def use_openclaw_1009_layout(self):
        # S24 01/11 23:35 (OpenClaw 2026.10.9): the config lock is state.<hash>.lock, no .sqlite sibling.
        self.config_lock.unlink(); Path(str(self.config_lock) + ".sqlite").unlink()
        self.config_lock = self.lock_dir / "state.27025f5de024db73.lock"
        self.config_lock.write_text(json.dumps(self.payload))

    def test_openclaw_1009_config_lock_is_recognised_and_recovered(self):
        self.use_openclaw_1009_layout()
        status = guard.stale_gateway_lock_status(
            self.state, self.config, 18789, proc_root=self.proc, port_probe=lambda port: False)
        self.assertEqual(status["state"], "stale_recoverable")
        result = guard.recover_stale_gateway_locks(
            self.state, self.config, 18789, proc_root=self.proc,
            backup_root=self.root / "backups", port_probe=lambda port: False)
        self.assertEqual(result["state"], "recovered")
        self.assertFalse(self.config_lock.exists()); self.assertFalse(self.state_lock.exists())
        self.assertTrue((Path(result["backup"]) / self.config_lock.name).is_file())

    def test_openclaw_1009_live_owner_is_never_reclaimed(self):
        self.use_openclaw_1009_layout(); self.add_process()
        status = guard.stale_gateway_lock_status(
            self.state, self.config, 18789, proc_root=self.proc, port_probe=lambda port: False)
        self.assertEqual(status["state"], "active_owner")

    def test_both_layouts_for_the_same_config_stay_ambiguous(self):
        (self.lock_dir / "state.27025f5de024db73.lock").write_text(json.dumps(self.payload))
        status = guard.stale_gateway_lock_status(
            self.state, self.config, 18789, proc_root=self.proc, port_probe=lambda port: False)
        self.assertEqual(status, {"state": "unsafe", "reason": "config_lock_ambiguous", "count": 2})

    def test_listener_blocks_lock_recovery(self):
        result = guard.stale_gateway_lock_status(
            self.state, self.config, 18789, proc_root=self.proc,
            port_probe=lambda port: True
        )
        self.assertEqual(result["state"], "active_listener")


class GatewayRecoveryScriptContractTests(unittest.TestCase):
    def test_recovery_start_is_lightweight_and_preserves_lock_preflight(self):
        text=(ROOT/'gateway-start.sh').read_text()
        self.assertIn('stale-locks', text)
        self.assertIn('exec openclaw gateway', text)
        self.assertNotIn('exec \"$SCRIPT_DIR/run.sh\"', text)
        self.assertNotIn('clawmobile_sync_workspace_seed', text)
        self.assertNotIn('clawmobile_build_plugin_lite', text)


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


# Schemas and rows captured on the S24 on 28/10 (OpenClaw 2026.9.6) when Doctor
# refused every Gateway start: PID 6136 had been reused by another Android app.
LEASES_SQL = """CREATE TABLE agent_database_leases (
  lease_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, path TEXT NOT NULL,
  owner_pid INTEGER NOT NULL, owner_start_time INTEGER, opened_at INTEGER NOT NULL) STRICT"""
VERIFICATIONS_SQL = """CREATE TABLE agent_integrity_verifications (
  path TEXT NOT NULL PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL,
  app_version TEXT NOT NULL, verified_at INTEGER NOT NULL,
  clean_close INTEGER NOT NULL CHECK (clean_close IN (0, 1))) STRICT"""
PULSE_DB = "/data/data/com.termux/files/home/.openclaw/agents/contacts-projet-pulse/agent/openclaw-agent.sqlite"
MAIN_DB = "/data/data/com.termux/files/home/.openclaw/agents/main/agent/openclaw-agent.sqlite"
S24_LEASES = [
    ("c30699ac-32d4-4994-915e-3e806df49eaa", "contacts-projet-pulse", PULSE_DB, 6136, 8459675, 1793199945208),
    ("375bf296-10fa-474b-ac5f-745d5d30835b", "contacts-projet-pulse", PULSE_DB, 6136, 8459675, 1793199948409),
    ("c29b2a6f-fdc0-4359-9b6c-0ac7e40d8220", "main", MAIN_DB, 19404, 9797491, 1793213375809),
    ("8dab4d37-6f74-4bb7-9e9c-6e02328137ea", "main", MAIN_DB, 21064, 10164504, 1793216998078),
]


def android_kill(pids):
    """6136: another app (EPERM); 19404: gone (ESRCH); 21064: ours."""
    def kill(pid, sig):
        if pids.get(pid) == "foreign":
            raise PermissionError(1, "Operation not permitted")
        if pids.get(pid) != "ours":
            raise ProcessLookupError(3, "No such process")
    return kill


class AgentLeaseTests(unittest.TestCase):
    def setUp(self):
        import sqlite3
        self.sqlite3 = sqlite3
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / ".openclaw"
        (self.state / "state").mkdir(parents=True)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        db = sqlite3.connect(self.state / "state" / "openclaw.sqlite")
        db.execute(LEASES_SQL)
        db.executemany("insert into agent_database_leases values (?,?,?,?,?,?)", S24_LEASES)
        db.commit(); db.close()
        q = sqlite3.connect(self.state / "state" / "openclaw-quarantine.sqlite")
        q.execute(VERIFICATIONS_SQL)
        for path in (PULSE_DB, MAIN_DB):
            q.execute("insert into agent_integrity_verifications values (?,?,?,?,?,?)", (path, "1", "2", "2026.9.6", 1, 1))
        q.commit(); q.close()
        self.kill = android_kill({6136: "foreign", 21064: "ours"})

    def leases(self):
        db = self.sqlite3.connect(self.state / "state" / "openclaw.sqlite")
        try:
            return [r[0] for r in db.execute("select lease_id from agent_database_leases order by opened_at")]
        finally:
            db.close()

    def test_only_leases_of_a_pid_reused_by_another_app_are_released(self):
        result = guard.recover_foreign_agent_leases(self.state, proc_root=self.proc,
                                                    backup_root=self.root / "backups", kill=self.kill)
        self.assertEqual(result["state"], "recovered")
        self.assertEqual(result["released"], 2)
        self.assertEqual(self.leases(), [S24_LEASES[2][0], S24_LEASES[3][0]])
        receipt = json.loads(Path(result["receipt"]).read_text())
        self.assertEqual({r["owner_pid"] for r in receipt["leases"]}, {6136})
        q = self.sqlite3.connect(self.state / "state" / "openclaw-quarantine.sqlite")
        self.assertEqual([r[0] for r in q.execute("select path from agent_integrity_verifications")], [MAIN_DB])
        q.close()

    def test_nothing_is_touched_while_a_gateway_runs(self):
        p = self.proc / "21064"
        p.mkdir()
        (p / "stat").write_text("21064 (node) " + " ".join(["S", "1"] + ["0"] * 17 + ["10164504"]))
        (p / "cmdline").write_bytes(b"openclaw-gateway\0")
        result = guard.recover_foreign_agent_leases(self.state, proc_root=self.proc, kill=self.kill)
        self.assertEqual(result["state"], "active_gateway")
        self.assertEqual(len(self.leases()), 4)

    def test_check_mode_reports_without_mutation(self):
        result = guard.recover_foreign_agent_leases(self.state, proc_root=self.proc, kill=self.kill, apply=False)
        self.assertEqual(result["state"], "foreign_leases")
        self.assertEqual(len(self.leases()), 4)

    def test_dead_and_own_owners_stay_with_openclaw(self):
        result = guard.recover_foreign_agent_leases(self.state, proc_root=self.proc,
                                                    kill=android_kill({21064: "ours"}))
        self.assertEqual(result["state"], "ok")
        self.assertEqual(len(self.leases()), 4)

    def test_gateway_start_runs_the_lease_preflight_before_starting(self):
        text = (ROOT / "gateway-start.sh").read_text()
        self.assertLess(text.index("agent-leases --state-dir"), text.index("exec openclaw gateway"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
