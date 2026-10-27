#!/data/data/com.termux/files/usr/bin/python3
"""The root guardian is not stuck behind an AI gate that cannot answer (S24 27/10 reboot)."""
import os
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GUARDIAN = ROOT / "samantha-root-guardian.sh"


class RootGuardianGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.name = "fixture-supervisor-" + uuid.uuid4().hex[:8] + ".sh"
        self.script = self.home / self.name
        self.script.write_text("#!/usr/bin/env bash\nwhile :; do sleep 1; done\n")
        self.script.chmod(0o755)
        self.other = self.home / ("old-" + self.name)
        self.other.write_text(self.script.read_text())
        self.other.chmod(0o755)

    def tearDown(self):
        subprocess.run(["pkill", "-f", self.name], check=False)
        self.tmp.cleanup()

    def guardian(self, *, gate_rc, gateway_up, rounds=1):
        # Functions of the real guardian; only the AI gate and the Gateway probe are synthetic.
        functions = GUARDIAN.read_text().split("\nrefresh_root\n", 1)[0]
        probe = self.home / "probe.sh"
        probe.write_text(functions + "\n"
            "immune_observe(){ :; }\n"
            f"immune_action(){{ echo gate >>\"$HOME/gate.calls\"; return {gate_rc}; }}\n"
            f"gate_reachable(){{ return {0 if gateway_up else 1}; }}\n"
            "ROOT=$HOME\n"
            + f"ensure_supervisor fixture '[{self.name[0]}]{self.name[1:]}' '{self.script}' \"$D/fixture.stderr.log\"\n" * rounds)
        subprocess.run(["bash", str(probe)], env=dict(os.environ, HOME=str(self.home)),
                       check=True, capture_output=True, text=True, timeout=60)

    def log(self):
        path = self.home / ".openclaw/guardian/guardian.log"
        return path.read_text() if path.exists() else ""

    def running(self, script):
        return subprocess.run(["pgrep", "-f", str(script)], capture_output=True).returncode == 0

    def test_missing_supervisor_starts_when_gate_is_unreachable(self):
        self.guardian(gate_rc=75, gateway_up=False)
        self.assertTrue(self.running(self.script))
        self.assertIn("event=fixture-missing action=direct_start reason=ai_gate_unreachable", self.log())
        self.assertIn("event=fixture-start result=ok", self.log())

    def test_reachable_gate_keeps_the_decision_and_refusal_is_logged_once(self):
        self.guardian(gate_rc=75, gateway_up=True, rounds=3)
        self.assertFalse(self.running(self.script))
        self.assertEqual(self.log().count("event=fixture-restore action=wait reason=ai_gate_refused"), 1)
        self.assertEqual((self.home / "gate.calls").read_text().count("gate"), 3)

    def test_direct_start_is_bounded_when_the_supervisor_keeps_dying(self):
        self.guardian(gate_rc=75, gateway_up=False)
        subprocess.run(["pkill", "-f", self.name], check=False)
        time.sleep(0.5)
        self.guardian(gate_rc=75, gateway_up=False)
        self.assertFalse(self.running(self.script))
        self.assertEqual(self.log().count("action=direct_start"), 1)

    def test_drifting_supervisor_still_waits_for_the_ai(self):
        drift = subprocess.Popen([str(self.other)], start_new_session=True)
        try:
            # The pattern matches the old release's process too, as on a real release switch.
            self.guardian(gate_rc=75, gateway_up=False)
            self.assertIsNone(drift.poll())
            self.assertNotIn("direct_start", self.log())
            self.assertIn("reason=ai_gate_refused", self.log())
        finally:
            drift.kill(); drift.wait()


if __name__ == "__main__":
    unittest.main()
