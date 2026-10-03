#!/data/data/com.termux/files/usr/bin/python3
import fcntl,os,subprocess,tempfile,time,unittest
from pathlib import Path
ROOT=Path(__file__).parent
class SupervisorLockTests(unittest.TestCase):
 def test_real_shell_accepts_free_lock_and_waits_for_actual_owner(self):
  with tempfile.TemporaryDirectory() as tmp:
   home=Path(tmp);w=home/'.openclaw/watchdogs';w.mkdir(parents=True)
   script=home/'probe.sh';prefix=(ROOT/'samantha-health-manager.sh').read_text().split("log 'event=start",1)[0]
   script.write_text(prefix+'\nwait_supervisor_lock remote_watchdog\n')
   env=dict(os.environ,HOME=str(home));p=subprocess.run(['bash',str(script)],env=env,capture_output=True,text=True,timeout=5);self.assertEqual(p.returncode,0,p.stderr)
   with (w/'remote-desktop.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    p=subprocess.Popen(['bash',str(script)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
     time.sleep(.2);self.assertIsNone(p.poll(),'lock owner was ignored')
     fcntl.flock(lock,fcntl.LOCK_UN);out,err=p.communicate(timeout=5);self.assertEqual(p.returncode,0,err)
    finally:
     if p.poll() is None:p.kill();p.wait()
if __name__=='__main__':unittest.main(verbosity=2)
