#!/usr/bin/env python3
"""core-services-watchdog.sh --gateway-only is owned by samantha-health-manager.sh (check_supervisor).

Real health-manager functions (check_supervisor, check_supervisor_effect, process_uses_script, start,
restart_gate) drive the real watchdog script as a real process in an isolated HOME:
- absent: started once, with --gateway-only; already running: never a second one;
- a legacy instance (no option, which would also restart the Companion) is replaced;
- AI gate unavailable and no Companion process: direct bounded start; with a Companion: no start;
- single owner: no other launcher starts the watchdog, and the health manager stays the only Companion owner.
"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from host_test_support import adapt_shebangs  # noqa: E402

MANAGER = HERE / "samantha-health-manager.sh"
WATCHDOG = HERE / "core-services-watchdog.sh"
GATE_SELECTED = 'immune_action(){ shift 2; "$@"; }; immune_observe(){ :; }\n'
GATE_UNAVAILABLE = 'immune_action(){ return 75; }; immune_observe(){ :; }\n'


def pids_running(script: Path):
    out = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            argv = (proc / "cmdline").read_bytes().split(b"\0")
            state = (proc / "stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if state != "Z" and str(script).encode() in argv:
            out.append((int(proc.name), [a.decode(errors="replace") for a in argv if a]))
    return out


class GatewayFallbackOwnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.home = self.tmp / "home"
        self.runtime = self.tmp / "runtime"
        (self.home / ".openclaw/deploys").mkdir(parents=True)
        self.runtime.mkdir()
        lock = self.home / ".openclaw/deploys/companion-deploy.lock"
        lock.touch()
        os.chmod(self.home / ".openclaw", 0o700)
        os.chmod(self.home / ".openclaw/deploys", 0o700)
        os.chmod(lock, 0o600)
        self.script = self.runtime / "core-services-watchdog.sh"
        shutil.copy(WATCHDOG, self.script)
        (self.runtime / "runtime_mode.py").symlink_to(HERE / "runtime_mode.py")
        for name, body in {
            "gateway-start.sh": f'echo start >>"{self.tmp}/gateway-starts"\n',
            "companion-server.sh": f'echo start >>"{self.tmp}/companion-starts"\n',
            "incident-notify.sh": f'printf "%s\\n" "$1" >>"{self.tmp}/notifications"\n',
        }.items():
            path = self.runtime / name
            path.write_text("#!/data/data/com.termux/files/usr/bin/bash\n" + body)
            path.chmod(0o700)
        self.script.chmod(0o700)
        adapt_shebangs(self.runtime)
        self.companion = None
        self.extra = []

    def tearDown(self):
        for pid, _ in pids_running(self.script):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for proc in [self.companion, *self.extra]:
            if proc and proc.poll() is None:
                proc.kill()
                proc.wait()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def env(self):
        return dict(
            os.environ,
            HOME=str(self.home),
            CLAW_RUNTIME_ROOT=str(self.runtime),
            CORE_SERVICES_WATCHDOG_INTERVAL_S="600",
            HEALTH_RESTART_BUDGET_N="3",
        )

    def start_companion(self):
        # Same process title as the S24 Companion; matched by the bracketed pattern of both scripts.
        self.companion = subprocess.Popen(["bash", "-c", 'exec -a "node dist/companion/server.js" sleep 600'])
        time.sleep(0.3)

    def assert_no_foreign_companion(self):
        for _ in range(50):
            if subprocess.run(["pgrep", "-f", "dist/companion/[s]erver.js"], capture_output=True).returncode:
                return
            time.sleep(0.1)
        self.fail("a Companion-like process is running on this host; the scenario needs none")

    def probe(self, gate: str, body: str):
        prefix = MANAGER.read_text().split("log 'event=start", 1)[0]
        probe = self.tmp / "probe.sh"
        probe.write_text(prefix + "\n" + gate + 'log(){ echo "$*" >>"$LOG"; }\n' + body)
        result = subprocess.run(["bash", str(probe)], env=self.env(), capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        log = self.home / ".openclaw/health/health.log"
        return log.read_text() if log.exists() else ""

    def watchdog_log(self):
        path = self.home / ".openclaw/watchdogs/core-services.log"
        for _ in range(50):
            if path.exists() and "event=start" in path.read_text():
                break
            time.sleep(0.1)
        return path.read_text() if path.exists() else ""

    CHECK = ("check_supervisor core_services_watchdog '/[c]ore-services-watchdog[.]sh( |$)' "
             '"$ROOT/core-services-watchdog.sh" --gateway-only\n')

    def test_absent_watchdog_is_started_once_and_never_duplicated(self):
        self.start_companion()
        log = self.probe(GATE_SELECTED, self.CHECK + "sleep 1\n" + self.CHECK + self.CHECK)
        running = pids_running(self.script)
        self.assertEqual(len(running), 1, running)
        self.assertEqual(running[0][1][-1], "--gateway-only", running[0])
        self.assertEqual(log.count("service=core_services_watchdog action=start"), 1, log)
        self.assertIn("service=core_services_watchdog state=healthy", log)
        attempts = (self.home / ".openclaw/health/state/core_services_watchdog.restart_attempts").read_text()
        self.assertEqual(len(attempts.split()), 1)
        wlog = self.watchdog_log()
        self.assertIn("event=start result=ok scope=gateway", wlog)
        # A live Companion owns the Gateway: the watchdog only records the hand-off.
        self.assertIn("event=gateway_owner owner=companion", wlog)
        self.assertFalse((self.tmp / "companion-starts").exists())
        self.assertFalse((self.tmp / "gateway-starts").exists())
        # The running watchdog holds its singleton lock: a second copy exits without starting.
        second = subprocess.run([str(self.script), "--gateway-only"], env=self.env(), timeout=10)
        self.assertEqual(second.returncode, 0)
        self.assertEqual(self.watchdog_log().count("event=start"), 1)
        self.assertEqual(len(pids_running(self.script)), 1)

    def test_legacy_instance_that_restarts_the_companion_is_replaced(self):
        self.start_companion()
        legacy = subprocess.Popen([str(self.script)], env=self.env(), stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.extra.append(legacy)
        for _ in range(50):
            if "scope=all" in self.watchdog_log():
                break
            time.sleep(0.1)
        log = self.probe(GATE_SELECTED, self.CHECK)
        self.assertIn("service=core_services_watchdog state=stale_runtime action=replace", log)
        self.assertIn("budget=exempt", log)
        legacy.wait(timeout=10)
        running = pids_running(self.script)
        self.assertEqual(len(running), 1, running)
        self.assertEqual(running[0][1][-1], "--gateway-only")
        self.assertIn("scope=gateway", self.watchdog_log())

    def test_test_runner_is_neither_counted_nor_stopped(self):
        """S24 localci diagnostics and CI run test-core-services-watchdog.sh: it must not look like the supervisor."""
        self.start_companion()
        runner = self.tmp / "installer/termux-lite/test-core-services-watchdog.sh"
        runner.parent.mkdir(parents=True)
        runner.write_text("#!/data/data/com.termux/files/usr/bin/bash\nsleep 600\n")
        runner.chmod(0o700)
        adapt_shebangs(runner)
        bystander = subprocess.Popen([str(runner)], start_new_session=True)
        self.extra.append(bystander)
        time.sleep(0.3)
        log = self.probe(GATE_SELECTED, self.CHECK)
        self.assertIsNone(bystander.poll(), "a test runner must never be stopped as a stale supervisor")
        self.assertNotIn("stale_runtime", log)
        self.assertIn("service=core_services_watchdog action=start", log)
        self.assertEqual(len(pids_running(self.script)), 1)

    def test_gate_unavailable_without_companion_starts_directly(self):
        self.assert_no_foreign_companion()
        log = self.probe(GATE_UNAVAILABLE, self.CHECK)
        self.assertIn("service=core_services_watchdog action=direct_repair reason=ai_gate_unreachable", log)
        self.assertIn("service=core_services_watchdog action=restart_authorized budget=1/3", log)
        running = pids_running(self.script)
        self.assertEqual(len(running), 1, running)
        self.assertEqual(running[0][1][-1], "--gateway-only")
        self.assertFalse((self.tmp / "companion-starts").exists(), "the watchdog must never start the Companion")

    def test_gate_unavailable_with_companion_waits(self):
        self.start_companion()
        log = self.probe(GATE_UNAVAILABLE, self.CHECK)
        self.assertNotIn("direct_repair", log)
        self.assertEqual(pids_running(self.script), [])

    def test_refused_admission_is_logged_once_per_episode(self):
        """05/11: adb_watchdog stayed down after a reboot; every refusal was silent."""
        self.start_companion()
        check = "check_supervisor adb_watchdog '[a]db-recovery-watchdog.sh' \"$ROOT/adb-recovery-watchdog.sh\"\n"
        log = self.probe(GATE_UNAVAILABLE, check + check + check)
        self.assertEqual(log.count("service=adb_watchdog state=down action=repair_not_admitted "
                                   "reason=immune_gate_refused"), 1, log)
        self.assertNotIn("service=adb_watchdog action=start", log)
        # Admitted again (here: the effect runs and fails to find the script): a later refusal is a new episode.
        log = self.probe(GATE_SELECTED, check)
        log = self.probe(GATE_UNAVAILABLE, check)
        self.assertEqual(log.count("action=repair_not_admitted"), 2, log)

    def test_single_owner_and_companion_ownership_unchanged(self):
        text = MANAGER.read_text()
        loop = text.split("log 'event=start", 1)[1]
        self.assertEqual(loop.count(self.CHECK), 1, "exactly one owner line in the main loop")
        self.assertIn('core_services_watchdog) printf \'%s\' "$HOME/.openclaw/watchdogs/core-services.lock"', text)
        # The Companion keeps exactly one owner in the health manager: check_http under the repair lease.
        self.assertEqual(loop.count("companion-server.sh"), 1)
        self.assertIn('check_http companion http://127.0.0.1:8765/', loop)
        # No other launcher starts the watchdog (no double supervision).
        for name in ("samantha-root-guardian.sh", "tier0-bootstrap.sh", "samantha-bootstrap.sh", "bootstrap.sh",
                     "tier0-watchdog.py", "adb-recovery-watchdog.sh", "remote-desktop-watchdog.sh",
                     "incident-manager.sh", "boot-continuity-recovery.sh"):
            path = HERE / name
            if path.exists():
                self.assertNotIn("core-services-watchdog", path.read_text(), name)
        # In its supervised mode the watchdog never starts the Companion.
        body = WATCHDOG.read_text()
        gateway_branch = body.split('if [ "$SCOPE" = gateway ]; then', 1)[1].split("else heal gw", 1)[0]
        self.assertNotIn("companion-server.sh", gateway_branch)


if __name__ == "__main__":
    unittest.main(verbosity=2)
