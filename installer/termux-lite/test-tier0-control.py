#!/data/data/com.termux/files/usr/bin/python3
import unittest
from pathlib import Path
class Tier0Tests(unittest.TestCase):
    def test_source_scripts_have_runtime_root_override(self):
        root=Path(__file__).resolve().parent
        names=['samantha-bootstrap.sh','samantha-root-guardian.sh','samantha-health-manager.sh','incident-orchestrator-worker.sh']
        for n in names:self.assertIn('CLAW_RUNTIME_ROOT',(root/n).read_text(),n)
    def test_tier0_scripts_exist(self):
        root=Path(__file__).resolve().parent
        for n in ['tier0-control.py','tier0-watchdog.py','tier0-bootstrap.sh','install-tier0-control.py']:self.assertTrue((root/n).is_file(),n)
if __name__=='__main__':unittest.main()
