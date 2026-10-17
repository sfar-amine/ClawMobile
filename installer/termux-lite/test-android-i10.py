#!/data/data/com.termux/files/usr/bin/python3
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
STARTUP = ROOT / "android-startup-check.py"
GAME_DAY = ROOT / "android-game-day.py"
SETUP = ROOT / "android-game-day-setup.sh"


FAKE_ADB = r'''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  *get-state*) printf 'device\n' ;;
  *"dumpsys activity settings"*) printf '  max_phantom_processes=%s\n' "${FAKE_PHANTOM:-128}" ;;
  *"dumpsys power"*) [ "${FAKE_WAKELOCK:-1}" = 1 ] && printf "  PARTIAL_WAKE_LOCK 'Termux:WakeLock' package=com.termux\n"; exit 0 ;;
  *"dumpsys deviceidle whitelist"*) [ "${FAKE_BATTERY:-1}" = 1 ] && printf 'user,com.termux,10234\n'; exit 0 ;;
  *disconnect*) exit 0 ;;
esac
'''


class AndroidStartupTests(unittest.TestCase):
    def run_startup(self, *, phantom="128", wakelock="1", battery="1", boot="boot-1", home=None):
        owned = tempfile.TemporaryDirectory() if home is None else None
        base = Path(owned.name) if owned else Path(home)
        bindir = base / "bin"
        bindir.mkdir(parents=True, exist_ok=True)
        adb = bindir / "adb"
        adb.write_text(FAKE_ADB)
        adb.chmod(0o700)
        runtime = base / "runtime"
        runtime.mkdir(exist_ok=True)
        notify = runtime / "incident-notify.sh"
        notify.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_NOTIFY_LOG"\n')
        notify.chmod(0o700)
        env = {
            **os.environ,
            "HOME": str(base),
            "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
            "CLAW_RUNTIME_ROOT": str(runtime),
            "CLAW_HEALTH_ROOT": str(base / "health"),
            "CLAW_BOOT_ID": boot,
            "FAKE_ADB_LOG": str(base / "adb.log"),
            "FAKE_NOTIFY_LOG": str(base / "notify.log"),
            "FAKE_PHANTOM": phantom,
            "FAKE_WAKELOCK": wakelock,
            "FAKE_BATTERY": battery,
        }
        proc = subprocess.run(["python3", str(STARTUP)], env=env, text=True, capture_output=True, timeout=10)
        row = json.loads(proc.stdout)
        result = (base, env, proc, row, owned)
        return result

    def test_closed_healthy_receipt_contains_all_three_guards(self):
        base, _, proc, row, owned = self.run_startup()
        try:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(row["state"], "closed")
            self.assertEqual(row["verdict"], "healthy")
            self.assertEqual(set(row["checks"]), {"adb", "phantom_processes", "termux_wakelock", "battery_optimization"})
            saved = json.loads((base / "health" / "android-startup.json").read_text())
            self.assertEqual(saved["boot_id"], "boot-1")
            self.assertFalse((base / "notify.log").exists())
        finally:
            owned.cleanup()

    def test_drift_is_closed_and_signalled_without_mutation(self):
        base, _, proc, row, owned = self.run_startup(phantom="32", wakelock="0", battery="0")
        try:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(row["state"], "closed")
            self.assertEqual(row["verdict"], "attention")
            self.assertEqual(len(row["attention"]), 3)
            adb_log = (base / "adb.log").read_text()
            self.assertNotIn("device_config put", adb_log)
            notice = (base / "notify.log").read_text()
            self.assertIn("phantom_processes:below_minimum", notice)
            self.assertIn("termux_wakelock:not_held", notice)
            self.assertIn("battery_optimization:not_exempt", notice)
        finally:
            owned.cleanup()

    def test_same_boot_reuses_closed_receipt_without_duplicate_signal(self):
        with tempfile.TemporaryDirectory() as tmp:
            base, env, first, _, _ = self.run_startup(phantom="32", home=tmp)
            self.assertEqual(first.returncode, 0, first.stderr)
            before = (base / "adb.log").read_text()
            second = subprocess.run(["python3", str(STARTUP)], env=env, text=True, capture_output=True, timeout=10)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((base / "adb.log").read_text(), before)
            self.assertEqual(len((base / "notify.log").read_text().splitlines()), 1)


class AndroidGameDayTests(unittest.TestCase):
    def make_runtime(self, base: Path):
        runtime = base / "runtime"
        runtime.mkdir()
        guard = runtime / "android-network-mutation-guard.py"
        guard.write_text('#!/usr/bin/env python3\nimport subprocess,sys\nraise SystemExit(subprocess.run(sys.argv[-2:]).returncode)\n')
        guard.chmod(0o700)
        gate = runtime / "learning-gate-close.sh"
        gate.write_text('#!/bin/sh\nprintf \'{"receipt_id":"game-day-proof"}\\n\'\n')
        gate.chmod(0o700)
        return runtime

    def test_requires_explicit_execute(self):
        proc = subprocess.run(["python3", str(GAME_DAY)], text=True, capture_output=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("refused_without_execute", proc.stderr)

    def test_bounded_three_phase_run_closes_and_enters_learning_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            runtime = self.make_runtime(base)
            bindir = base / "bin"
            bindir.mkdir()
            for name, body in {
                "pkill": "exit 0",
                "curl": "exit 0",
                "adb": "[ \"$1\" = disconnect ] && exit 0; printf 'device\\n'",
                "no-sleep": "exit 0",
            }.items():
                path = bindir / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o700)
            env = {
                **os.environ,
                "HOME": str(base),
                "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
                "CLAW_RUNTIME_ROOT": str(runtime),
                "CLAW_HEALTH_ROOT": str(base / "health"),
                "CLAW_GAME_DAY_SLEEP": "no-sleep",
            }
            proc = subprocess.run(
                ["python3", str(GAME_DAY), "--execute", "--duration-seconds", "30", "--run-id", "test-2026-10"],
                env=env, text=True, capture_output=True, timeout=10,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            row = json.loads(proc.stdout)
            self.assertEqual(row["state"], "closed")
            self.assertEqual(row["result"], "passed")
            self.assertEqual([p["name"] for p in row["phases"]], ["gateway_kill_9", "network_cut", "adb_loss"])
            self.assertEqual(row["duration_budget_seconds"], 30)
            self.assertEqual(row["learning_gate"]["ok"], True)
            self.assertEqual(json.loads((base / "health" / "android-game-day.json").read_text())["learning_gate"]["ok"], True)

    def test_setup_reuses_openclaw_scheduler(self):
        text = SETUP.read_text()
        self.assertIn('openclaw cron list --json', text)
        self.assertIn('openclaw cron edit "$existing"', text)
        self.assertIn('openclaw cron add', text)
        self.assertIn('--every 30d', text)
        self.assertIn('$HOME/.openclaw/tier0/bin/android-game-day-run.sh', text)
        self.assertNotIn('crontab', text)

    def test_default_runner_is_exactly_thirty_minutes(self):
        runner = (ROOT / "android-game-day-run.sh").read_text()
        self.assertIn("--duration-seconds 1800", runner)
        installer = (ROOT / "install-tier0-control.py").read_text()
        self.assertIn("'android-game-day-run.sh'", installer)

    def test_learning_gate_accepts_canonical_game_day_source(self):
        gate = (ROOT / "learning-gate.py").read_text()
        self.assertIn('"game_day"', gate)


if __name__ == "__main__":
    unittest.main(verbosity=2)
