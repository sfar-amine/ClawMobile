#!/usr/bin/env python3
"""I4: every repair owner consumes the existing stop/deployment mode."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import runtime_mode


class RuntimeModeTests(unittest.TestCase):
    def test_normal_deployment_stop_and_invalid_stop_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            self.assertEqual(runtime_mode.current_mode(home), "normal")
            lock = home / "deploys/companion-deploy.lock"
            lock.parent.mkdir(parents=True)
            fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                self.assertEqual(runtime_mode.current_mode(home), "deployment")
                stop = home / "tier0/emergency-stop.json"
                stop.parent.mkdir(parents=True)
                stop.write_text(json.dumps({"enabled": True, "reason": "test"}))
                self.assertEqual(runtime_mode.current_mode(home), "emergency_stop")
                stop.write_text("{bad")
                self.assertEqual(runtime_mode.current_mode(home), "unknown")
            finally:
                os.close(fd)

    def test_deployment_guard_reuses_only_the_verified_inherited_lock(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            lock = home / "deploys/companion-deploy.lock"
            lock.parent.mkdir(parents=True)
            fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                with patch.dict(os.environ, {"SAMANTHA_DEPLOY_LOCK_FD": str(fd)}):
                    with runtime_mode.deployment_guard(home) as used:
                        self.assertEqual(used, fd)
                        self.assertEqual(runtime_mode.current_mode(home), "deployment")
            finally:
                os.close(fd)

    def test_deployment_guard_refuses_a_foreign_holder_after_a_bounded_wait(self):
        # Bascule 17/10: older parent deploy held the lock without SAMANTHA_DEPLOY_LOCK_FD -> promote waited forever.
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            lock = home / "deploys/companion-deploy.lock"
            lock.parent.mkdir(parents=True)
            holder = subprocess.Popen([sys.executable, "-c",
                "import fcntl,sys,time;f=open(sys.argv[1],'a');fcntl.flock(f,fcntl.LOCK_EX);print('held',flush=True);time.sleep(30)",
                str(lock)], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(holder.stdout.readline().strip(), "held")
                with patch.dict(os.environ, {"SAMANTHA_DEPLOY_LOCK_FD": ""}):
                    began = time.monotonic()
                    with self.assertRaises(runtime_mode.DeploymentLockBusy) as caught:
                        with runtime_mode.deployment_guard(home, wait_seconds=0.5):
                            self.fail("guard must not be entered")
                    self.assertLess(time.monotonic() - began, 3)
                    self.assertIn("SAMANTHA_DEPLOY_LOCK_FD", str(caught.exception))
            finally:
                holder.kill(); holder.wait()
            with runtime_mode.deployment_guard(home, wait_seconds=0.5) as fd:
                self.assertIsInstance(fd, int)

    def test_all_i4_owners_read_the_canonical_module(self):
        readers = {
            "samantha-health-manager.sh": 'runtime_mode.py',
            "incident-orchestrator-worker.sh": 'runtime_mode.py',
            "autonomous-engineering-shadow.sh": 'runtime_mode.py',
            "companion-nightly-acceptance.py": 'runtime_mode.current_mode',
        }
        for name, marker in readers.items():
            self.assertIn(marker, (ROOT / name).read_text(), name)
        self.assertIn("deployment_guard", (ROOT / "tier0-control.py").read_text())

    def test_cli_refuses_repairs_under_stop(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            stop = home / "tier0/emergency-stop.json"
            stop.parent.mkdir(parents=True)
            stop.write_text('{"enabled":true}')
            run = subprocess.run(
                [sys.executable, str(ROOT / "runtime_mode.py"), "--openclaw-home", str(home)],
                text=True, capture_output=True, timeout=5,
            )
            self.assertEqual(run.returncode, 75)
            self.assertEqual(run.stdout.strip(), "emergency_stop")

    def test_gateway_owner_lease_identifies_only_the_live_recorded_process(self):
        # Real S24 row (01/11, OpenClaw 2026.10.9): state_leases schema and gateway-owner payload.
        capture = json.loads((ROOT.parent.parent / "openclaw-plugin-mobile-ui/fixtures/"
                              "s24-2026-11-01-deploy-restart-1009/capture.json").read_text())["state_leases"]
        row = capture["gateway_owner_row"]
        import sqlite3

        def started(pid):
            text = Path(f"/proc/{pid}/stat").read_text()
            return int(text[text.rindex(")") + 2:].split()[19])

        def write(state, pid, started_at):
            db = state / "state/openclaw.sqlite"
            db.parent.mkdir(parents=True, exist_ok=True)
            if db.exists():
                db.unlink()
            payload = json.loads(json.dumps(row["payload_json"]))
            payload["owner"]["pid"] = pid
            payload["owner"]["startedAt"] = started_at
            con = sqlite3.connect(db)
            con.execute(capture["sql"])
            con.execute("insert into state_leases values (?,?,?,?,?,?,?,?)",
                        (row["scope"], row["lease_key"], row["owner"], row["expires_at"], row["heartbeat_at"],
                         json.dumps(payload), row["created_at"], row["updated_at"]))
            con.commit(); con.close()

        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            self.assertIsNone(runtime_mode.gateway_owner_pid(state))
            write(state, os.getpid(), started(os.getpid()))
            self.assertEqual(runtime_mode.gateway_owner_pid(state), os.getpid())
            run = subprocess.run([sys.executable, str(ROOT / "runtime_mode.py"), "--gateway-owner-pid", str(state)],
                                 text=True, capture_output=True, timeout=5)
            self.assertEqual((run.returncode, json.loads(run.stdout)), (0, {"pid": os.getpid()}))
            write(state, os.getpid(), started(os.getpid()) + 1)  # reused pid: another start time
            self.assertIsNone(runtime_mode.gateway_owner_pid(state))
            dead = subprocess.Popen([sys.executable, "-c", "pass"]); dead.wait()
            write(state, dead.pid, None)
            self.assertIsNone(runtime_mode.gateway_owner_pid(state))


if __name__ == "__main__":
    unittest.main()
