#!/data/data/com.termux/files/usr/bin/python3
import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('native_recovery',ROOT/'native-recovery-entrypoint.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NativeRecoveryTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();base=Path(self.t.name)
  self.old=(m.HOME,m.OC,m.TIER0,m.BIN,m.HEALTH,m.RECEIPT,m.LOCK)
  m.HOME=base;m.OC=base/'.openclaw';m.TIER0=m.OC/'tier0';m.BIN=m.TIER0/'bin';m.HEALTH=m.OC/'health';m.RECEIPT=m.HEALTH/'native-recovery-last.json';m.LOCK=m.TIER0/'native-recovery.lock'
  m.BIN.mkdir(parents=True);m.HEALTH.mkdir(parents=True)
 def tearDown(self):
  m.HOME,m.OC,m.TIER0,m.BIN,m.HEALTH,m.RECEIPT,m.LOCK=self.old;self.t.cleanup()
 def test_repair_respects_emergency_stop(self):
  (m.TIER0/'emergency-stop.json').write_text('{}')
  with patch.object(m,'start_tier0') as start:
   out=m.repair(2)
  self.assertEqual(out['state'],'deferred');start.assert_not_called()
 def test_network_reconcile_skips_without_adb(self):
  class R:returncode=1;stdout='';stderr=''
  with patch.object(m,'_run',return_value=R()):out=m.network_reconcile(Path('/runtime'))
  self.assertEqual(out['reason'],'adb_unavailable')
 def test_repair_is_bounded_and_uses_existing_tier0(self):
  root=Path(self.t.name)/'runtime';root.mkdir()
  good={'critical_capabilities':['immune.health_manager'],'bad_critical':{},'slack_bridge':'healthy','emergency_stop':False,'runtime_root':str(root)}
  with patch.object(m,'runtime_root',return_value=root),patch.object(m,'network_reconcile',return_value={'state':'healthy'}),patch.object(m,'start_tier0',return_value={'state':'started'}),patch.object(m,'snapshot',return_value=good):
   out=m.repair(2)
  self.assertEqual(out['state'],'healthy');self.assertEqual(out['boot']['state'],'started')
 def test_only_health_and_repair_actions_are_cli_choices(self):
  # Parser contract is encoded as argparse choices; source guard prevents arbitrary shell surface.
  src=(ROOT/'native-recovery-entrypoint.py').read_text();self.assertIn("choices=('health','repair')",src);self.assertNotIn('shell=True',src)
if __name__=='__main__':unittest.main(verbosity=2)
