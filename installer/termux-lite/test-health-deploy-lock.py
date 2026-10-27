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
    def run_check(self, hold_lock: bool, idle_proven: bool = True, missing_lock: bool = False,
                  companion_alive: bool = False, gate_refuses: bool = False, gateway_up: bool = False) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            deploys = home / ".openclaw/deploys"
            deploys.mkdir(parents=True)
            lock_path = deploys / "companion-deploy.lock"
            lock = lock_path.open("w")
            if hold_lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
            if missing_lock:
                lock.close(); lock_path.unlink()
            prefix = MANAGER.read_text().split("log 'event=start", 1)[0]
            probe = home / "probe.sh"
            # Server down, no process: without the lock the manager starts a repair (start is stubbed).
            idle = "return 0" if idle_proven else "return 1"
            alive = "return 0" if companion_alive else "return 1"
            gateway = "[ \"$1\" = http://127.0.0.1:18789/healthz ] && return 0; " if gateway_up else ""
            gate = "return 75" if gate_refuses else 'shift 2; "$@"'
            probe.write_text(prefix + f"\nhttp(){{ {gateway}return 1; }}; proc(){{ {alive}; }}; sleep(){{ :; }}; pkill(){{ :; }}; companion_idle_proven(){{ {idle}; }}; start(){{ echo STARTED >>\"$HOME/started\"; }}\n"
                             f"immune_action(){{ {gate}; }}; immune_observe(){{ :; }}\n"
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

    def test_missing_lock_is_created_and_does_not_disable_repair(self):
        out = self.run_check(hold_lock=False, missing_lock=True)
        self.assertIn("action=repair", out)
        self.assertIn("STARTED", out)

    def test_companion_repair_requires_existing_idle_proof(self):
        # A live but unhealthy Companion may own runs: no replacement without the idle proof.
        out = self.run_check(hold_lock=False, idle_proven=False, companion_alive=True)
        self.assertIn("state=idle_unproven action=skip_repair", out)
        self.assertNotIn("action=repair", out)
        self.assertNotIn("STARTED", out)

    def test_dead_companion_restarts_without_idle_proof(self):
        # S24 27/10: the proof failed (remote_bridge_scan_partial) for a Companion with no
        # process at all, and Samantha stayed down after internet came back.
        out = self.run_check(hold_lock=False, idle_proven=False, companion_alive=False)
        self.assertNotIn("idle_unproven", out)
        self.assertIn("action=repair", out)
        self.assertIn("STARTED", out)

    def test_dead_companion_restarts_when_the_ai_gate_cannot_answer(self):
        # S24 27/10 reboot: the gate reaches its models through the Gateway, which the
        # Companion owns; it always refused and the Companion never came back.
        out = self.run_check(hold_lock=False, gate_refuses=True, gateway_up=False)
        self.assertIn("service=companion action=direct_repair reason=ai_gate_unreachable", out)
        self.assertIn("action=restart_authorized", out)
        self.assertIn("STARTED", out)

    def test_reachable_gate_keeps_the_decision(self):
        out = self.run_check(hold_lock=False, gate_refuses=True, gateway_up=True)
        self.assertIn("service=companion state=ai_gate_refused action=wait", out)
        self.assertNotIn("direct_repair", out)
        self.assertNotIn("STARTED", out)

    def test_live_companion_is_never_replaced_without_the_ai(self):
        out = self.run_check(hold_lock=False, gate_refuses=True, gateway_up=False, companion_alive=True)
        self.assertNotIn("direct_repair", out)
        self.assertNotIn("STARTED", out)


if __name__ == "__main__":
    unittest.main()
