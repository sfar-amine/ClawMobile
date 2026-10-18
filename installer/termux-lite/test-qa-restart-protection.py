#!/usr/bin/env python3
"""Q12: exercise the installed deployment owner with real flock and EOF pipes."""
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import runtime_mode


class RestartProtection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.lock = self.home / "deploys/companion-deploy.lock"
        self.lock.parent.mkdir()
        self.lock.touch(mode=0o600)

    def start_lease(self, inherited=None):
        env = {**os.environ, "SAMANTHA_DEPLOY_LOCK_FD": str(inherited) if inherited is not None else ""}
        child = subprocess.Popen([sys.executable, str(ROOT / "runtime_mode.py"),
            "--openclaw-home", str(self.home), "--repair-lease"],
            env=env, pass_fds=(() if inherited is None else (inherited,)),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.wait(timeout=2)
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()
        self.addCleanup(cleanup)
        self.assertTrue(select.select([child.stdout], [], [], 3)[0], "ACK deadline")
        return child, json.loads(child.stdout.readline())

    def assert_lock_free(self):
        with self.lock.open() as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_campaign_shared_lock_refuses_lease_and_mode(self):
        with self.lock.open() as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            self.assertEqual(runtime_mode.current_mode(self.home), "deployment")
            child, ack = self.start_lease()
            self.assertEqual(ack, {"version": 1, "state": "refused", "cause": "lock_busy"})
            self.assertEqual(child.wait(timeout=2), 75)

    def test_inherited_valid_fd_reports_real_campaign_contention(self):
        with self.lock.open() as campaign, self.lock.open() as parent:
            fcntl.flock(campaign, fcntl.LOCK_SH)
            child, ack = self.start_lease(parent.fileno())
            self.assertEqual(ack, {"version": 1, "state": "refused", "cause": "lock_busy"})
            self.assertEqual(child.wait(timeout=2), 75)

    def test_lease_holds_ex_until_owner_eof(self):
        child, ack = self.start_lease()
        self.assertEqual(ack, {"version": 1, "state": "acquired"})
        self.assertEqual(runtime_mode.current_mode(self.home), "deployment")
        with self.lock.open() as f:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(f, fcntl.LOCK_SH | fcntl.LOCK_NB)
        child.stdin.close()
        self.assertEqual(child.wait(timeout=2), 0)
        self.assert_lock_free()

    def test_parent_fd_retains_ex_after_helper_sigkill(self):
        fd = os.open(self.lock, os.O_RDONLY)
        try:
            child, ack = self.start_lease(fd)
            self.assertEqual(ack["state"], "acquired")
            child.kill(); child.wait(timeout=2)
            self.assertEqual(runtime_mode.current_mode(self.home), "deployment")
        finally:
            os.close(fd)
        self.assert_lock_free()

    def test_supplied_foreign_fd_refuses_without_open_description_fallback(self):
        foreign = self.home / "foreign"
        foreign.touch()
        fd = os.open(foreign, os.O_RDONLY)
        try:
            child, ack = self.start_lease(fd)
            self.assertEqual(ack, {"version": 1, "state": "refused", "cause": "unavailable"})
            self.assertEqual(child.wait(timeout=2), 75)
        finally:
            os.close(fd)
        self.assert_lock_free()

    def test_emergency_stop_refuses_without_lock_mutation(self):
        stop = self.home / "tier0/emergency-stop.json"
        stop.parent.mkdir(); stop.write_text('{"enabled":true}')
        child, ack = self.start_lease()
        self.assertEqual(ack["cause"], "emergency_stop")
        self.assertEqual(child.wait(timeout=2), 75)
        self.assert_lock_free()

    def test_bad_stop_and_symlink_lock_fail_closed(self):
        stop = self.home / "tier0/emergency-stop.json"
        stop.parent.mkdir(); stop.write_text('{')
        child, ack = self.start_lease()
        self.assertEqual(ack["cause"], "unavailable"); child.wait(timeout=2)
        stop.unlink()
        self.lock.unlink(); self.lock.symlink_to(self.home / "other")
        child, ack = self.start_lease()
        self.assertEqual(ack["state"], "refused")
        self.assertEqual(child.wait(timeout=2), 75)
        self.assertFalse((self.home / "other").exists())

    def shell(self, body):
        # Source only the real owner function definitions; no daemon loop or
        # actual process/HTTP operations. Test mutations are explicit overrides.
        source = (ROOT / "samantha-health-manager.sh").read_text()
        functions = source[source.index("start(){"):source.index("\nprocess_uses_script()")] + "\n" + source[source.index("with_repair_lease() ("):source.index("\ncheck_adb()")]
        env = {**os.environ, "OPENCLAW_HOME": str(self.home), "CLAW_RUNTIME_ROOT": str(ROOT)}
        return subprocess.run(["bash", "-uc", 'ROOT="$CLAW_RUNTIME_ROOT"\n' + functions + '\n' + body],
            env=env, text=True, capture_output=True, timeout=6)

    def test_health_refuses_campaign_without_entering_repair(self):
        with self.lock.open() as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            result = self.shell('log(){ :; }; mutate(){ echo forbidden; }; with_repair_lease mutate companion')
            self.assertEqual(result.returncode, 75, result.stderr)
            self.assertNotIn("forbidden", result.stdout)

    def test_health_owner_holds_lock_through_final_check_and_start(self):
        body = '''
log(){ :; }; http(){ return 1; }; proc(){ return 1; }
restart_gate(){ python3 "$ROOT/runtime_mode.py" --openclaw-home "$OPENCLAW_HOME" || [ "$?" = 75 ]; }
start(){ python3 "$ROOT/runtime_mode.py" --openclaw-home "$OPENCLAW_HOME"; }
sleep(){ :; }; fail(){ :; }
with_repair_lease repair_http_under_lease companion ignored ignored ignored 0 0
'''
        result = self.shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["deployment", "deployment"])
        self.assert_lock_free()

    def test_health_final_healthy_check_does_not_consume_budget(self):
        result = self.shell('''
log(){ :; }; http(){ return 0; }; healthy(){ echo healthy; }
restart_gate(){ echo forbidden; }; start(){ echo forbidden; }
with_repair_lease repair_http_under_lease companion ignored ignored ignored 0 0
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "healthy")
        self.assert_lock_free()

    def test_repaired_daemon_does_not_inherit_lease(self):
        script = self.home / "safe-child.sh"
        # A real background child remains alive after the repair owner exits.
        script.write_text('#!/bin/sh\necho "$$" > "$OPENCLAW_HOME/child.pid"\nsleep 2\n')
        script.chmod(0o700)
        result = self.shell('''
D="$OPENCLAW_HOME"
log(){ :; }; http(){ return 1; }; proc(){ return 1; }
restart_gate(){ return 0; }; sleep(){ :; }; fail(){ :; }
with_repair_lease repair_http_under_lease companion ignored ignored "$OPENCLAW_HOME/safe-child.sh" 0 0
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        pid_path = self.home / "child.pid"
        deadline = time.monotonic() + 1
        while not pid_path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        pid = int(pid_path.read_text())
        try:
            os.kill(pid, 0)
            self.assert_lock_free()
        finally:
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass

    def test_source_capture_confirms_actual_owners(self):
        fixture = Path(__file__).resolve().parents[2] / "openclaw-plugin-mobile-ui/fixtures/qa/restart-source-s24-20261018.json"
        row = json.loads(fixture.read_text())
        files = row["files"]
        self.assertEqual(len(files), 5)
        self.assertTrue(all(f["exists"] and len(f["sha256"]) == 64 for f in files))
        self.assertFalse(any(f["has_restart_proof_route"] for f in files))


if __name__ == "__main__":
    unittest.main()
