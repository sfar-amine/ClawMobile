#!/usr/bin/env python3
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("incident_orchestrator", ROOT / "incident-orchestrator.py")
ORCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORCH)


class IncidentCorrelationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        ORCH.DB = Path(self.tmp.name) / "orchestrator.db"

    def tearDown(self):
        self.tmp.cleanup()

    def test_probe_incident_action_result_share_one_correlation(self):
        correlation_id = "probe-1791880000-42-companion"
        incident = ORCH.open_incident(
            "companion", "runtime", "health-manager", "readiness failed",
            correlation_id, "probe",
        )
        incident_id = incident["id"]
        ORCH.transition(incident_id, "diagnosing", "health-manager", "bounded recovery exhausted")
        ORCH.transition(incident_id, "planning", "orchestrator-worker", "handler selected")
        ORCH.transition(incident_id, "repairing", "orchestrator-worker", "restart requested")
        ORCH.transition(incident_id, "verifying", "orchestrator-worker", "readiness probe")
        ORCH.transition(incident_id, "recovered", "orchestrator-worker", "readiness verified")

        shown = ORCH.show(incident_id)
        self.assertEqual(shown["incident"]["correlation_id"], correlation_id)
        self.assertEqual({event["correlation_id"] for event in shown["events"]}, {correlation_id})
        payloads = [json.loads(event["payload"]) for event in shown["events"]]
        self.assertEqual({payload["correlation_id"] for payload in payloads}, {correlation_id})
        stages = [payload["stage"] for payload in payloads]
        self.assertLess(stages.index("probe"), stages.index("incident"))
        self.assertLess(stages.index("incident"), stages.index("action"))
        self.assertLess(stages.index("action"), stages.index("result"))

    def test_dedupe_keeps_correlation_and_recurrence_renews_it(self):
        first = ORCH.open_incident("adb", "boot-a", "health-manager", "down", "probe-first-0001", "probe")
        same = ORCH.open_incident("adb", "boot-a", "health-manager", "still down", "probe-next-00002", "probe")
        self.assertEqual(first["id"], same["id"])
        self.assertEqual(first["correlation_id"], same["correlation_id"])
        ORCH.transition(first["id"], "verifying", "health-manager", "transport ready")
        ORCH.transition(first["id"], "recovered", "health-manager", "transport verified")
        recurrence = ORCH.open_incident("adb", "boot-a", "health-manager", "down again", "probe-third-0003", "probe")
        self.assertNotEqual(first["id"], recurrence["id"])
        self.assertEqual(recurrence["correlation_id"], "probe-third-0003")

    def test_legacy_schema_is_migrated_without_losing_events(self):
        db = sqlite3.connect(ORCH.DB)
        db.executescript("""
        CREATE TABLE incidents(id TEXT PRIMARY KEY,component TEXT,scope TEXT,state TEXT,created REAL,updated REAL,human_boundary INTEGER DEFAULT 0,human_reason TEXT,summary TEXT,next_retry REAL NOT NULL DEFAULT 0);
        CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,incident_id TEXT,ts REAL,source TEXT,kind TEXT,payload TEXT);
        INSERT INTO incidents VALUES('legacy01','whatsapp','runtime','detected',1,1,0,NULL,'down',0);
        INSERT INTO events(incident_id,ts,source,kind,payload) VALUES('legacy01',1,'health-manager','observed','{}');
        """)
        db.commit()
        db.close()
        ORCH.connect().close()
        shown = ORCH.show("legacy01")
        self.assertRegex(shown["incident"]["correlation_id"], r"^corr-legacy-[0-9a-f]{16}$")
        self.assertEqual(shown["events"][0]["correlation_id"], shown["incident"]["correlation_id"])

    def test_rejects_unbounded_or_unsafe_external_identifier(self):
        with self.assertRaises(ValueError):
            ORCH.open_incident("gateway", "runtime", "test", "down", "bad id; token=secret", "probe")

    def test_runtime_owners_emit_and_log_correlation(self):
        health = (ROOT / "samantha-health-manager.sh").read_text()
        worker = (ROOT / "incident-orchestrator-worker.sh").read_text()
        self.assertIn('--observation-kind probe', health)
        self.assertIn('correlation_id=$correlation_id', health)
        self.assertIn('select id,component,scope,state,correlation_id', worker)
        self.assertIn('correlation_id=%s', worker)
        continuation = (ROOT / "incident-continuation.py").read_text()
        self.assertIn("'correlation_id':correlation_id or None", continuation)


if __name__ == "__main__":
    unittest.main()
