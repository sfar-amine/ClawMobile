#!/usr/bin/env python3
"""R02: a battery-powered phone with saturated RAM is postponed before fetch/build/restart."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent


class DeployPreflight(unittest.TestCase):
    def test_low_ram_on_battery_writes_deferred_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td) / "repo" / "installer" / "termux-lite"
            root.mkdir(parents=True)
            shutil.copy2(HERE / "companion-deploy.sh", root / "companion-deploy.sh")
            (root / "bounded-log.py").write_text("# no-op\n")
            repo = root.parents[1]
            subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "r02@test"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "R02"], check=True)
            (repo / "marker").write_text("fixture")
            subprocess.run(["git", "-C", str(repo), "add", "marker"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "fixture"], check=True)
            home = pathlib.Path(td) / "home"; home.mkdir()
            mem = pathlib.Path(td) / "meminfo"; mem.write_text("MemAvailable:         524288 kB\n")
            battery = pathlib.Path(td) / "battery"; battery.write_text("Discharging\n")
            env = dict(os.environ, HOME=str(home), COMPANION_DEPLOY_MEMINFO_FILE=str(mem),
                       COMPANION_DEPLOY_BATTERY_STATUS_FILE=str(battery))
            run = subprocess.run(["bash", str(root / "companion-deploy.sh"), "a" * 40], env=env,
                                 capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 0, run.stderr)
            receipt = pathlib.Path(run.stdout.strip().splitlines()[-1])
            doc = json.loads(receipt.read_text())
            self.assertEqual(doc["state"], "deferred")
            self.assertIn("battery=discharging", doc["detail"])
            self.assertIn("retry_when_powered_or_memory_recovers", doc["detail"])


if __name__ == "__main__":
    unittest.main()
