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
 def test_semantic_maintenance_degrades_overall(self):
  old_oc,old_now=hv.OC,hv.NOW
  with tempfile.TemporaryDirectory() as td:
   hv.OC=Path(td);hv.NOW=1000
   p=hv.OC/'autonomous-engineering';p.mkdir(parents=True)
   (p/'maintenance-last.json').write_text(json.dumps({'checked_at':990,'task_health':{'state':'attention_required','unfinished':1},'semantic_health':{'state':'attention_required','attention':[{'component':'task_health','state':'attention_required'}]}}))
   m=hv.maintenance_view();self.assertEqual(m['semantic_state'],'degraded')
   old_live,old_inc,old_cont=hv.live,hv.incidents,hv.continuations
   try:
    hv.live=lambda:{};hv.incidents=lambda:([],[],[]);hv.continuations=lambda:{'blocked':0,'resuming':0,'stuck':0,'details':[]}
    out=hv.build();self.assertEqual(out['capabilities']['control_plane.maintenance']['state'],'degraded');self.assertEqual(out['overall'],'degraded')
   finally:
    hv.live, hv.incidents, hv.continuations=old_live,old_inc,old_cont
  hv.OC, hv.NOW=old_oc,old_now
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
