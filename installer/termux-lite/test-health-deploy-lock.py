#!/data/data/com.termux/files/usr/bin/python3
"""The health manager never repairs the Companion while companion-deploy.sh holds its lock (S24 11/10)."""
import fcntl
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANAGER = ROOT / "samantha-health-manager.sh"


class HealthDeployLockTests(unittest.TestCase):
    def run_check(self, hold_lock: bool) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            deploys = home / ".openclaw/deploys"
            deploys.mkdir(parents=True)
            lock_path = deploys / "companion-deploy.lock"
            lock = lock_path.open("w")
            if hold_lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
            prefix = MANAGER.read_text().split("log 'event=start", 1)[0]
            probe = home / "probe.sh"
            # Server down, no process: without the lock the manager starts a repair (start is stubbed).
            probe.write_text(prefix + "\nhttp(){ return 1; }; proc(){ return 1; }; sleep(){ :; }; start(){ echo STARTED >>\"$HOME/started\"; }\n"
                             "check_http companion http://127.0.0.1:1/ 'nomatch-[x]' /bin/true 0 0\n")
            env = dict(os.environ, HOME=str(home), CLAW_RUNTIME_ROOT=str(ROOT))
            subprocess.run(["bash", str(probe)], env=env, check=False, capture_output=True, text=True, timeout=30)
            lock.close()
            log = (home / ".openclaw/health/health.log")
            started = (home / "started").exists()
            return (log.read_text() if log.exists() else "") + ("\nSTARTED" if started else "")

    def test_deploy_lock_skips_repair(self):
        out = self.run_check(hold_lock=True)
        self.assertIn("state=deploy_in_progress action=skip_repair", out)
        self.assertNotIn("action=repair", out)
        self.assertNotIn("STARTED", out)

    def test_without_deploy_lock_repair_still_happens(self):
        out = self.run_check(hold_lock=False)
        self.assertIn("action=repair", out)
        self.assertIn("STARTED", out)


if __name__ == "__main__":
    unittest.main()
