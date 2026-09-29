#!/data/data/com.termux/files/usr/bin/python3
import importlib.util,json,tempfile,time,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('hv',Path(__file__).with_name('health-verdict.py'));hv=importlib.util.module_from_spec(spec);spec.loader.exec_module(hv)
class T(unittest.TestCase):
 def test_item(self):
  x=hv.item('healthy',True,evidence='x');self.assertEqual(x['state'],'healthy');self.assertTrue(x['critical'])
 def test_continuation_gap(self):
  old=hv.OC
  with tempfile.TemporaryDirectory() as td:
   hv.OC=Path(td);p=hv.OC/'continuations';p.mkdir()
   (p/'retrieval-runs.json').write_text(json.dumps({'r':{'state':'blocked','updated_at':time.time()-600}}))
   self.assertEqual(hv.continuations()['stuck'],1)
  hv.OC=old
 def test_adb_recovery_readiness_receipt(self):
  with tempfile.TemporaryDirectory() as td:
   path=Path(td)/'ready.json'
   path.write_text(json.dumps({'checked_at':time.time(),'state':'degraded','reason':'wireless_debugging_disabled'}))
   state,reason,fresh=hv.adb_recovery_readiness(path)
   self.assertEqual(state,'degraded');self.assertEqual(reason,'wireless_debugging_disabled');self.assertLess(fresh,5)
 def test_adb_recovery_readiness_stale(self):
  with tempfile.TemporaryDirectory() as td:
   path=Path(td)/'ready.json'
   path.write_text(json.dumps({'checked_at':time.time()-400,'state':'ready','reason':'ok'}))
   state,reason,_=hv.adb_recovery_readiness(path)
   self.assertEqual(state,'stale');self.assertEqual(reason,'readiness_receipt_stale')
 def test_historical_failed_not_active(self):
  old=hv.OC
  with tempfile.TemporaryDirectory() as td:
   hv.OC=Path(td);p=hv.OC/'incidents';p.mkdir()
   import sqlite3
   c=sqlite3.connect(p/'orchestrator.db');c.execute('create table incidents(id text,component text,scope text,state text,created real,updated real,human_boundary int,human_reason text,summary text)')
   c.execute('insert into incidents values(?,?,?,?,?,?,?,?,?)',('i','x','runtime','failed',time.time()-10,time.time()-5,0,None,'old'));c.commit();c.close()
   a,f,h=hv.incidents();self.assertEqual(a,[]);self.assertEqual(len(f),1)
  hv.OC=old
if __name__=='__main__':unittest.main()
