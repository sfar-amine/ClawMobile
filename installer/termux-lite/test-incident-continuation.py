#!/data/data/com.termux/files/usr/bin/python3
import importlib.util,json,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).parent
def mod(name,file):
 s=importlib.util.spec_from_file_location(name,ROOT/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
io=mod('io', 'incident-orchestrator.py');ic=mod('ic','incident-continuation.py')
class T(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();base=Path(self.t.name);io.DB=base/'inc.db';ic.DB=io.DB;ic.BASE=base/'cont';ic.LINKS=ic.BASE/'incident-links.json';ic.EVENTS=ic.BASE/'incident-events.jsonl'
 def tearDown(self):self.t.cleanup()
 def test_contract_link(self):
  a=io.open_incident('x','runtime','test','x');m=ic.link(a['id'],'cap.x','R1','runs.json');self.assertEqual(m['affected_capability'],'cap.x')
 def test_terminal_event(self):
  a=io.open_incident('x','runtime','test','x');ic.link(a['id'],'cap.x')
  ev=ic.emit(a['id'],'failed','x','runtime','boom');self.assertEqual(ev['state'],'failed');self.assertEqual(ev['affected_capability'],'cap.x')
 def test_inherit_preserves_capability_and_run_link(self):
  a=io.open_incident('x','runtime','test','x');ic.link(a['id'],'cap.x','R1','runs.json')
  b=io.open_incident('y','runtime','test','y');m=ic.inherit(a['id'],b['id'])
  self.assertEqual(m['affected_capability'],'cap.x');self.assertEqual(m['run_id'],'R1');self.assertEqual(m['inherited_from'],a['id'])
  self.assertEqual(ic.load_links()[b['id']]['ledger'],'runs.json')
 def test_reconcile_emits_state(self):
  a=io.open_incident('x','runtime','test','x');ic.link(a['id'],'cap.x')
  r=ic.reconcile();self.assertEqual(r['emitted'],1);self.assertTrue(ic.EVENTS.exists())
if __name__=='__main__':unittest.main()
