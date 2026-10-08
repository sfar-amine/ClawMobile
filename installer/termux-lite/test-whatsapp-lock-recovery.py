#!/data/data/com.termux/files/usr/bin/python3
import datetime as dt, json, os, subprocess, sys, tempfile, time, unittest
from pathlib import Path
SCRIPT = Path(__file__).with_name("whatsapp-lock-recovery.py")


def proc_stat(pid: int, start: int) -> str:
    return f"{pid} (test) S " + " ".join(["0"] * 18 + [str(start)]) + "\n"


class TestRecovery(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.addCleanup(self.t.cleanup)
        self.root = Path(self.t.name); self.lock = self.root / "default.lock"
        self.proc = self.root / "proc"; self.q = self.root / "q"; self.receipt = self.root / "receipt.json"
    def write_lock(self, pid=99, start=123, age=300):
        self.lock.write_text(json.dumps({"pid": pid, "starttime": start, "createdAt": "2026-01-01T00:00:00Z"}))
        os.utime(self.lock, (time.time() - age, time.time() - age))
    def run_recovery(self):
        return subprocess.run([sys.executable, str(SCRIPT), "--lock", str(self.lock), "--proc-root", str(self.proc),
            "--quarantine-dir", str(self.q), "--receipt", str(self.receipt), "--grace-seconds", "120"],
            capture_output=True, text=True)
    def test_dead_pid_quarantined_once(self):
        self.write_lock(); a=self.run_recovery(); self.assertEqual(a.returncode,10); self.assertFalse(self.lock.exists())
        self.assertEqual(self.run_recovery().returncode,0); self.assertEqual(len(list(self.q.iterdir())),1)
    def test_live_owner_untouched(self):
        self.write_lock(); p=self.proc/"99"; p.mkdir(parents=True); (p/"stat").write_text(proc_stat(99,123))
        a=self.run_recovery(); self.assertEqual(a.returncode,20); self.assertTrue(self.lock.exists())
    def test_pid_reuse_quarantined(self):
        self.write_lock(); p=self.proc/"99"; p.mkdir(parents=True); (p/"stat").write_text(proc_stat(99,456))
        self.assertEqual(self.run_recovery().returncode,10)
    def test_recent_lock_waits(self):
        self.write_lock(age=5); self.assertEqual(self.run_recovery().returncode,0); self.assertTrue(self.lock.exists())
    def test_malformed_refused(self):
        self.lock.write_text("{"); a=self.run_recovery(); self.assertEqual(a.returncode,30); self.assertTrue(self.lock.exists())

if __name__ == "__main__": unittest.main()
