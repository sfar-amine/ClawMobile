#!/usr/bin/env python3
"""File 52 M3: audited temporal actions remain a shadow projection."""
import contextlib
import datetime
import hashlib
import importlib.util
import json
import os
import runpy
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("curator_store", HERE / "context-store.py")
store = importlib.util.module_from_spec(spec); spec.loader.exec_module(store)
from context_curator import apply_actions
from context_memory import COLUMNS, event

NOW = datetime.datetime(2026, 10, 13, 20, 10, tzinfo=datetime.timezone.utc)


class CuratorActions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.conn = sqlite3.connect(self.root / "memory.db", isolation_level=None)
        store.migrate(self.conn)

    def tearDown(self): self.conn.close(); self.tmp.cleanup()

    def add(self, revision, text, kind="decision", supersedes=None, created=None):
        identifier = hashlib.sha256(f"m3-event-{revision}".encode()).hexdigest()
        self.conn.execute("INSERT INTO events(id,revision,surface,kind,text,created_at,supersedes) VALUES(?,?,?,?,?,?,?)",
                          (identifier, revision, "chat", kind, text, created or f"2026-10-13T{revision:02d}:00:00+00:00", supersedes))
        return identifier

    def rows(self):
        return [event(row) for row in self.conn.execute(f"SELECT {COLUMNS} FROM events e ORDER BY revision")]

    def test_add_update_invalidate_have_temporal_audit_and_are_idempotent(self):
        original = self.add(1, "Le rendez-vous est mardi")
        replacement = self.add(2, "Le rendez-vous est mercredi", supersedes=original)
        receipt = self.add(3, 'MEMORY_RETIRE_V1 {"reason":"annulé"}', "checkpoint", replacement)
        before = list(self.conn.execute("SELECT * FROM events ORDER BY revision"))
        result = apply_actions(self.conn, self.rows(), "run-1", NOW)
        self.assertEqual(result["counts"], {"ADD": 1, "UPDATE": 1, "INVALIDATE": 1})
        self.assertEqual(before, list(self.conn.execute("SELECT * FROM events ORDER BY revision")))
        facts = list(self.conn.execute("SELECT event_id,root_event_id,valid_from,valid_to,state,invalidated_by FROM curated_facts ORDER BY valid_from"))
        self.assertEqual(facts[0], (original, original, "2026-10-13T01:00:00+00:00", "2026-10-13T02:00:00+00:00", "superseded", replacement))
        self.assertEqual(facts[1], (replacement, original, "2026-10-13T02:00:00+00:00", "2026-10-13T03:00:00+00:00", "invalidated", receipt))
        audit = list(self.conn.execute("SELECT action,event_id,prior_event_id,valid_from,valid_to FROM curator_audit ORDER BY rowid"))
        self.assertEqual([row[0] for row in audit], ["ADD", "UPDATE", "INVALIDATE"])
        self.assertEqual(audit[-1][2:], (replacement, "2026-10-13T02:00:00+00:00", "2026-10-13T03:00:00+00:00"))
        self.assertEqual(apply_actions(self.conn, self.rows(), "run-2", NOW)["counts"], {"ADD": 0, "UPDATE": 0, "INVALIDATE": 0})
        self.assertEqual(3, self.conn.execute("SELECT count(*) FROM curator_audit").fetchone()[0])

    def test_duplicate_is_not_merged_and_invalid_date_is_not_applied(self):
        first = self.add(1, "Même fait durable")
        second = self.add(2, "Même fait durable")
        invalid = self.add(3, "Date invalide", created="hier")
        result = apply_actions(self.conn, self.rows(), "run", NOW)
        self.assertEqual(result["counts"], {"ADD": 2, "UPDATE": 0, "INVALIDATE": 0})
        self.assertEqual(result["invalidCount"], 1)
        active = {row[0] for row in self.conn.execute("SELECT event_id FROM curated_facts WHERE state='active'")}
        self.assertEqual(active, {first, second}); self.assertNotIn(invalid, active)

    def test_context_dream_keeps_shadow_and_records_actions(self):
        self.add(1, "Décision durable")
        home = self.root / "home"; state = home / ".openclaw" / "context-sync"
        state.mkdir(parents=True); self.conn.close()
        os.replace(self.root / "memory.db", state / "memory.db")
        output = __import__("io").StringIO()
        with patch.dict(os.environ, {"HOME": str(home), "SAMANTHA_CONTEXT_ROOT": str(state)}), patch("pathlib.Path.home", return_value=home), contextlib.redirect_stdout(output):
            runpy.run_path(str(HERE / "context-dream.py"), run_name="__main__")
        result = json.loads(output.getvalue())
        self.assertEqual(result["mode"], "shadow")
        self.assertEqual(result["factActions"], {"ADD": 1, "UPDATE": 0, "INVALIDATE": 0})
        self.conn = sqlite3.connect(state / "memory.db", isolation_level=None)


if __name__ == "__main__": unittest.main(verbosity=2)
