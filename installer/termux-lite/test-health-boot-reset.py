#!/data/data/com.termux/files/usr/bin/python3
"""After a reboot the health manager forgets the previous boot's service states (S24 27/10)."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANAGER = ROOT / "samantha-health-manager.sh"
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")


@unittest.skipUnless(BOOT_ID.exists(), "needs a Linux boot_id")
class HealthBootResetTests(unittest.TestCase):
    def run_prefix(self, home: Path):
        prefix = MANAGER.read_text().split("log 'event=start", 1)[0]
        probe = home / "probe.sh"
        probe.write_text(prefix)
        env = dict(os.environ, HOME=str(home), CLAW_RUNTIME_ROOT=str(ROOT))
        subprocess.run(["bash", str(probe)], env=env, check=False, capture_output=True, text=True, timeout=30)

    def test_new_boot_resets_service_states_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            state = home / ".openclaw/health/state"
            state.mkdir(parents=True)
            # The 27/10 capture: dead services still "healthy", companion with a 15 min backoff.
            for name, value in {"sshd.status": "healthy", "slack_bridge.status": "healthy",
                                "companion.status": "degraded", "companion.failures": "6",
                                "companion.next": "1793095000", "canonical_mode.status": "normal",
                                "boot_id": "previous-boot"}.items():
                (state / name).write_text(value)
            self.run_prefix(home)
            read = lambda name: (state / name).read_text()
            self.assertEqual(read("sshd.status"), "unknown")
            self.assertEqual(read("slack_bridge.status"), "unknown")
            self.assertEqual((read("companion.status"), read("companion.failures"), read("companion.next")),
                             ("unknown", "0", "0"))
            self.assertEqual(read("canonical_mode.status"), "normal")
            self.assertEqual(read("boot_id"), BOOT_ID.read_text().strip())
            self.assertIn("event=new_boot action=reset_service_states",
                          (home / ".openclaw/health/health.log").read_text())
            # Same boot: a later restart of the manager keeps the states it observed.
            (state / "sshd.status").write_text("healthy")
            self.run_prefix(home)
            self.assertEqual(read("sshd.status"), "healthy")

    def test_first_start_without_record_keeps_states(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            state = home / ".openclaw/health/state"
            state.mkdir(parents=True)
            (state / "companion.status").write_text("degraded")
            (state / "companion.failures").write_text("3")
            self.run_prefix(home)
            self.assertEqual((state / "companion.status").read_text(), "degraded")
            self.assertEqual((state / "companion.failures").read_text(), "3")
            self.assertEqual((state / "boot_id").read_text(), BOOT_ID.read_text().strip())


if __name__ == "__main__":
    unittest.main()
