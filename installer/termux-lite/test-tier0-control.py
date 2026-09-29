#!/data/data/com.termux/files/usr/bin/python3
import unittest
from pathlib import Path
class Tier0Tests(unittest.TestCase):
    def test_source_scripts_have_runtime_root_override(self):
        root=Path(__file__).resolve().parent
        names=['samantha-bootstrap.sh','samantha-root-guardian.sh','samantha-health-manager.sh','incident-orchestrator-worker.sh']
        for n in names:self.assertIn('CLAW_RUNTIME_ROOT',(root/n).read_text(),n)
    def test_soak_grace_is_declared(self):
        root=Path(__file__).resolve().parent
        self.assertIn('startup_grace_seconds',(root/'tier0-control.py').read_text())
        self.assertIn('soak_grace_until_epoch',(root/'tier0-watchdog.py').read_text())
    def test_tier0_scripts_exist(self):
        root=Path(__file__).resolve().parent
        for n in ['tier0-control.py','tier0-watchdog.py','tier0-bootstrap.sh','install-tier0-control.py']:self.assertTrue((root/n).is_file(),n)
if __name__=='__main__':unittest.main()
