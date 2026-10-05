#!/data/data/com.termux/files/usr/bin/python3
import os, subprocess, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).parent
WRAPPER=ROOT/'remote-desktop-bash'
class ShellBoundaryTests(unittest.TestCase):
    def test_wrapper_restores_termux_runtime_env_for_login_command(self):
        with tempfile.TemporaryDirectory() as td:
            home=Path(td); env={'HOME':str(home),'PATH':'/data/data/com.termux/files/usr/bin:/bin','SHELL':str(WRAPPER)}
            out=subprocess.run([str(WRAPPER),'-l','-c','printf "%s\\n%s\\n%s\\n%s" "$PREFIX" "$TMPDIR" "$TMP" "$TEMP"'],env=env,text=True,capture_output=True,check=True).stdout.splitlines()
            self.assertEqual(out[0],'/data/data/com.termux/files/usr')
            self.assertEqual(out[1:], [str(home/'.cache/tmp')]*3)
            self.assertTrue((home/'.cache/tmp').is_dir())
if __name__=='__main__': unittest.main(verbosity=2)
