#!/usr/bin/env python3
"""I1: un composant sans handler reste ouvert puis récupère sur le même incident."""
import json
import os
import sqlite3
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class DeterministicRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.runtime = self.home / "runtime"
        self.runtime.mkdir()
        (self.home / ".openclaw" / "health").mkdir(parents=True)
        (self.home / ".openclaw" / "incidents").mkdir(parents=True)
        self.env = {**os.environ, "HOME": str(self.home), "CLAW_RUNTIME_ROOT": str(self.runtime),
                    "INCIDENT_WORKER_POLL_S": "0.05"}
        self._wrapper("incident-orchestrator.py", f'exec python3 "{HERE / "incident-orchestrator.py"}" "$@"')
        self._wrapper("engineering-repair.sh", "exit 1")
        runtime_mode = self.runtime / "runtime_mode.py"
        runtime_mode.write_text("print('normal')\n")
        runtime_mode.chmod(0o755)
        self._wrapper("incident-close.sh", "exit 0")
        bounded_log = self.runtime / "bounded-log.py"
        bounded_log.write_text("#!/usr/bin/env python3\n")
        bounded_log.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def _wrapper(self, name, body):
        path = self.runtime / name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)

    def orchestrator(self, *args):
        return json.loads(subprocess.run(
            [str(self.runtime / "incident-orchestrator.py"), *args], env=self.env,
            text=True, capture_output=True, check=True).stdout)

    def state(self, incident_id):
        db = self.home / ".openclaw" / "incidents" / "orchestrator.db"
        with sqlite3.connect(db) as conn:
            row = conn.execute("select state from incidents where id=?", (incident_id,)).fetchone()
        return row[0]

    def wait_state(self, incident_id, expected):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.state(incident_id) == expected:
                return
            time.sleep(0.03)
        self.fail(f"incident {incident_id} never reached {expected}; state={self.state(incident_id)}")

    def test_worker_never_fails_unhandled_incident_and_health_manager_closes_same_id(self):
        opened = self.orchestrator("open", "companion", "runtime", "--source", "health-manager", "--summary", "down")
        incident_id = opened["id"]
        worker = subprocess.Popen(
            ["bash", str(HERE / "incident-orchestrator-worker.sh")], env=self.env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.wait_state(incident_id, "awaiting_deterministic_recovery")
        finally:
            worker.terminate()
            worker.wait(timeout=5)

        # Exercise the real health-manager healthy() function without starting its endless loop.
        manager = (HERE / "samantha-health-manager.sh").read_text()
        prefix = manager.split("log 'event=start result=ok state=persistent_backoff'", 1)[0]
        prefix_path = self.home / "health-manager-functions.sh"
        prefix_path.write_text(prefix)
        state_dir = self.home / ".openclaw" / "health" / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "companion.status").write_text("degraded")
        (state_dir / "companion.failures").write_text("3")
        subprocess.run(["bash", "-c", f'. "{prefix_path}"; healthy companion'], env=self.env, check=True)

        recovered = self.orchestrator("show", incident_id)
        self.assertEqual(recovered["incident"]["id"], incident_id)
        self.assertEqual(recovered["incident"]["state"], "recovered")
        transitions = [json.loads(e["payload"])["to"] for e in recovered["events"] if e["kind"] == "transition"]
        self.assertEqual(transitions, ["awaiting_deterministic_recovery", "verifying", "recovered"])
        self.assertNotIn("failed", transitions)


if __name__ == "__main__":
    unittest.main()
