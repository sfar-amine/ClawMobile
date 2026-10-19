"""O1 independent real-process regressions. Fake adb is filesystem-only, never Android."""
import importlib.util,json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
SOURCE=Path(__file__).with_name('android-network-mutation-guard.py').resolve()
spec=importlib.util.spec_from_file_location('consultation_safety',SOURCE);guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
class ProcessSafety(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.wifi=self.root/'wifi';self.wifi.write_text('on')
  binary=self.root/'bin';binary.mkdir();adb=binary/'adb'
  adb.write_text('#!'+sys.executable+'\n'+"import os,sys\nfrom pathlib import Path\np=Path(os.environ['O1_TEST_WIFI']);args=sys.argv[3:]\nif args==['shell','settings','list','global']: print('multi_sim_data_call=1')\nelif args==['shell','settings','get','global','multi_sim_data_call']: print('1')\nelif args==['shell','cmd','wifi','status']: print('Wi-Fi is '+('enabled' if p.read_text()=='on' else 'disabled'))\nelif args[:3]==['shell','svc','wifi']: p.write_text('on' if args[3]=='enable' else 'off')\nelif args==['shell','dumpsys','isub']: print('SubscriptionInfo{ id=1 simSlotIndex=0 mcc=605 mnc=01}')\nelif args==['shell','dumpsys','connectivity']:\n if p.read_text()=='on': print('Active default network: 111\\nNetworkAgentInfo{network{111} handle{99} ni{WIFI CONNECTED extra: REDACTED} nc{[ Transports: WIFI Capabilities: INTERNET&NOT_VPN&VALIDATED ]}}')\n else: print('Active default network: 127\\nNetworkAgentInfo{network{127} handle{1197406605325} ni{MOBILE[LTE] CONNECTED extra: weborange} nc{[ Transports: CELLULAR Capabilities: INTERNET&NOT_VPN&VALIDATED Specifier: <TelephonyNetworkSpecifier [mSubId = 1]> SubscriptionIds: {1} ]}}')\nelse: raise SystemExit(5)\n");adb.chmod(0o700)
  (self.root/'sitecustomize.py').write_text('import os\nfrom pathlib import Path\nPath.home=classmethod(lambda cls: Path(os.environ["O1_TEST_ROOT"]))\n')
  package=self.root/'telecom';package.mkdir();(package/'__init__.py').write_text('')
  (package/'maxit_guarded_service.py').write_text('''import json,os,subprocess,sys,time
from pathlib import Path
from unittest.mock import patch
source=os.environ['O1_TEST_GUARD'];pointer=os.environ['SAMANTHA_MAXIT_LEASE_ID']
p=subprocess.run([sys.executable,source,'verify-consultation-lease',pointer],capture_output=True,text=True)
if p.returncode: raise SystemExit(5)
proof=json.loads(p.stdout)
assert proof=={'success':True,'lease_id':pointer}
time.sleep(float(os.environ.get('O1_TEST_WAIT','0')))
print(json.dumps({'ok':True,'dns_ready_ms':12}))
''')
  self.env=os.environ.copy();self.env.update(O1_TEST_ROOT=str(self.root),PATH=str(binary)+os.pathsep+self.env.get('PATH',''),PYTHONPATH=str(self.root),O1_TEST_WIFI=str(self.wifi),O1_TEST_GUARD=str(SOURCE))
  self.command=[sys.executable,str(SOURCE),'with-consultation-receipt','--',sys.executable,'-m','telecom.maxit_guarded_service','balance']
 def tearDown(self):self.tmp.cleanup()
 def test_real_canonical_guard_admits_only_its_child_then_restores(self):
  result=subprocess.run(self.command,env=self.env,capture_output=True,text=True,timeout=10)
  self.assertEqual(result.returncode,0,result.stderr);proof=json.loads(result.stdout)['network_guard'];self.assertTrue(proof['restored']);self.assertTrue(proof['wifi_initial']);self.assertEqual(self.wifi.read_text(),'on')
 def test_ordinary_python_parent_cannot_forge_owner_lease(self):
  script='''import importlib.util,json,os,subprocess,sys,time
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('guard',sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
g.LEASES.mkdir(parents=True,exist_ok=True);pid=os.getpid();identity=g.process_identity(pid)
row={'schema_version':1,'type':'wifi_off','purpose':'maxit-deterministic','owner_pid':pid,'owner_identity':identity,'created_at':time.time()}
(g.LEASES/('a'*32+'.json')).write_text(json.dumps(row))
p=subprocess.run([sys.executable,sys.argv[1],'verify-consultation-lease','a'*32],capture_output=True,text=True)
print(p.stdout.strip())
'''
  result=subprocess.run([sys.executable,'-c',script,str(SOURCE)],env=self.env,capture_output=True,text=True,timeout=5)
  self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout),{'success':False,'reason':'maxit_guard_required'})
 def test_concurrent_guards_snapshot_only_after_the_lock(self):
  env={**self.env,'O1_TEST_WAIT':'.2'};first=subprocess.Popen(self.command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  deadline=time.monotonic()+5
  while self.wifi.read_text()!='off' and time.monotonic()<deadline:time.sleep(.01)
  self.assertEqual(self.wifi.read_text(),'off')
  second=subprocess.Popen(self.command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  outputs=[first.communicate(timeout=10),second.communicate(timeout=10)]
  self.assertEqual([first.returncode,second.returncode],[0,0],outputs)
  for stdout,_ in outputs:
   proof=json.loads(stdout)['network_guard'];self.assertTrue(proof['wifi_initial']);self.assertTrue(proof['restored'])
  self.assertEqual(self.wifi.read_text(),'on')
 def test_timeout_kills_grandchild_before_any_return(self):
  marker=self.root/'escaped-effect';child_script='import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",'+repr('import time;from pathlib import Path;time.sleep(.3);Path('+repr(str(marker))+').write_text("unexpected")')+']);time.sleep(5)'
  with self.assertRaises(guard.ConsultationChildFailure) as caught:
   guard.collect_consultation_child([sys.executable,'-c',child_script],self.env,timeout_s=.05)
  self.assertTrue(caught.exception.cleanup_verified);time.sleep(.4);self.assertFalse(marker.exists())
 def test_closed_streams_do_not_leave_nominal_descendant_running(self):
  marker=self.root/'nominal-after-restore'
  worker='import time;from pathlib import Path;time.sleep(.3);Path('+repr(str(marker))+').write_text("unexpected")'
  script='import subprocess,sys;subprocess.Popen([sys.executable,"-c",'+repr(worker)+'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print("{}")'
  result=guard.collect_consultation_child([sys.executable,'-c',script],self.env,timeout_s=5)
  self.assertEqual(result.returncode,0);time.sleep(.4);self.assertFalse(marker.exists())
 def test_selector_failure_cannot_launch_an_untracked_child(self):
  with patch.object(guard.selectors,'DefaultSelector',side_effect=OSError('TEST')),patch.object(guard.subprocess,'Popen') as launch:
   with self.assertRaises(OSError):guard.collect_consultation_child([sys.executable,'-c','pass'],self.env)
  launch.assert_not_called()
 def test_cleanup_interrupt_is_a_failure_even_after_nominal_output(self):
  with patch.object(guard,'stop_consultation_group',side_effect=KeyboardInterrupt()):
   with self.assertRaises(guard.ConsultationChildFailure) as caught:guard.collect_consultation_child([sys.executable,'-c','print("{}")'],self.env)
  self.assertFalse(caught.exception.cleanup_verified)
 def test_output_is_bounded_while_reading_both_streams(self):
  script='import os,time;data=b"x"*65536\nfor _ in range(100):os.write(2,data)\ntime.sleep(10)'
  started=time.monotonic()
  with self.assertRaises(guard.ConsultationChildFailure) as caught:guard.collect_consultation_child([sys.executable,'-c',script],self.env,timeout_s=5)
  self.assertTrue(caught.exception.cleanup_verified);self.assertLess(time.monotonic()-started,2)
if __name__=='__main__':unittest.main()
