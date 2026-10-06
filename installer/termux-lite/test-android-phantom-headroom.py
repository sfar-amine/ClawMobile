#!/data/data/com.termux/files/usr/bin/python3
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANAGER = ROOT / "samantha-health-manager.sh"

FAKE_ADB = r"""#!/data/data/com.termux/files/usr/bin/bash
set -u
printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  *"get-state"*)
    printf 'device\n'
    exit 0
    ;;
  *"shell dumpsys activity settings"*)
    printf '  max_phantom_processes=%s\n' "$(cat "$FAKE_EFFECTIVE")"
    exit 0
    ;;
  *"shell device_config get activity_manager max_phantom_processes"*)
    cat "$FAKE_OVERRIDE"
    printf '\n'
    exit 0
    ;;
  *"shell device_config put activity_manager max_phantom_processes 128"*)
    [ "${FAKE_PUT_FAIL:-0}" = "1" ] && exit 1
    printf '128' > "$FAKE_OVERRIDE"
    printf '128' > "$FAKE_EFFECTIVE"
    exit 0
    ;;
esac
exit 2
"""

class AndroidPhantomHeadroomTests(unittest.TestCase):
    def run_probe(self, effective: int, override: str, put_fail: bool = False):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            bindir = home / "bin"
            bindir.mkdir()
            fake_adb = bindir / "adb"
            fake_adb.write_text(FAKE_ADB)
            fake_adb.chmod(0o700)

            effective_file = home / "effective"
            override_file = home / "override"
            adb_log = home / "adb.log"
            effective_file.write_text(str(effective))
            override_file.write_text(override)

            prefix = MANAGER.read_text().split("log 'event=start", 1)[0]
            probe = home / "probe.sh"
            probe.write_text(prefix + "\ncheck_android_phantom_headroom\n")
            probe.chmod(0o700)

            env = dict(os.environ)
            env.update(
                HOME=str(home),
                PATH=str(bindir) + os.pathsep + env.get("PATH", ""),
                CLAW_RUNTIME_ROOT=str(ROOT),
                FAKE_EFFECTIVE=str(effective_file),
                FAKE_OVERRIDE=str(override_file),
                FAKE_ADB_LOG=str(adb_log),
                FAKE_PUT_FAIL="1" if put_fail else "0",
            )
            result = subprocess.run(
                ["bash", str(probe)],
                env=env,
                capture_output=True,
                text=True,
                timeout=8,
            )
            state = home / ".openclaw" / "health" / "state"
            return {
                "result": result,
                "effective": effective_file.read_text().strip(),
                "override": override_file.read_text().strip(),
                "adb_log": adb_log.read_text() if adb_log.exists() else "",
                "health_log": (home / ".openclaw" / "health" / "health.log").read_text(),
                "status": (state / "android_phantom_headroom.status").read_text().strip(),
                "failures": (state / "android_phantom_headroom.failures").read_text().strip(),
                "next": int((state / "android_phantom_headroom.next").read_text().strip()),
            }

    def test_healthy_headroom_is_read_only(self):
        row = self.run_probe(128, "128")
        self.assertEqual(row["result"].returncode, 0, row["result"].stderr)
        self.assertEqual(row["effective"], "128")
        self.assertEqual(row["override"], "128")
        self.assertNotIn("device_config put", row["adb_log"])
        self.assertEqual(row["status"], "healthy")
        self.assertEqual(row["failures"], "0")
        self.assertGreater(row["next"], int(time.time()))

    def test_drift_is_restored_and_verified(self):
        row = self.run_probe(32, "null")
        self.assertEqual(row["result"].returncode, 0, row["result"].stderr)
        self.assertEqual(row["effective"], "128")
        self.assertEqual(row["override"], "128")
        self.assertEqual(row["adb_log"].count("device_config put"), 1)
        self.assertIn("state=drift", row["health_log"])
        self.assertIn("state=recovered", row["health_log"])
        self.assertEqual(row["status"], "healthy")
        self.assertEqual(row["failures"], "0")

    def test_failed_restore_uses_existing_backoff(self):
        row = self.run_probe(32, "null", put_fail=True)
        self.assertEqual(row["result"].returncode, 0, row["result"].stderr)
        self.assertEqual(row["effective"], "32")
        self.assertEqual(row["status"], "degraded")
        self.assertEqual(row["failures"], "1")
        self.assertGreater(row["next"], int(time.time()))

if __name__ == "__main__":
    unittest.main(verbosity=2)
