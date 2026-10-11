#!/data/data/com.termux/files/usr/bin/python3
"""F5 (fichiers 35/41) : hystérésis et seuils du verdict santé sur la fenêtre réelle
capturée le 10-11/10 (fixtures/s24-2026-10-11b/f5/health-correlated-window.json)."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).resolve().parent
FIX=HERE.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11b/f5/health-correlated-window.json'
spec=importlib.util.spec_from_file_location('hv_f5',HERE/'health-verdict.py');hv=importlib.util.module_from_spec(spec);spec.loader.exec_module(hv)
W=json.loads(FIX.read_text())
COLS=W['samples']['columns']
ROWS=[dict(zip(COLS,r)) for r in W['samples']['rows']]

def maintenance_at(row,threshold):
 old_oc,old_now,old_thr=hv.OC,hv.NOW,hv.MAINTENANCE_RECEIPT_STALE_S
 try:
  with tempfile.TemporaryDirectory() as td:
   hv.OC=Path(td);hv.NOW=float(row['verdict.generated_at']);hv.MAINTENANCE_RECEIPT_STALE_S=threshold
   p=hv.OC/'autonomous-engineering';p.mkdir(parents=True)
   (p/'maintenance-last.json').write_text(json.dumps({'checked_at':row['maintenance_last.checked_at'],'task_health':{'state':'healthy'},'semantic_health':{'state':'attention_required','attention':[{'component':'transaction_health'}]}}))
   return hv.maintenance_view()
 finally:
  hv.OC,hv.NOW,hv.MAINTENANCE_RECEIPT_STALE_S=old_oc,old_now,old_thr

class F5Window(unittest.TestCase):
 def test_fixture_shape(self):
  self.assertEqual(len(ROWS),18)
  self.assertEqual(W['maintenanceJob']['schedule']['everyMs'],900000)
  self.assertTrue(W['maintenanceJob']['receiptCheckedAtIsRunStart'])

 def test_old_threshold_reproduces_captured_stale_flip(self):
  # 660 s : relevés 10 à 14 « maintenance_receipt_stale », exactement comme la capture.
  for row in ROWS:
   m=maintenance_at(row,660)
   got='stale' if m['state']=='stale' else 'degraded'
   self.assertEqual(got,row['cap.control_plane.maintenance.state'],row['sample'])

 def test_new_threshold_covers_cadence_and_run(self):
  self.assertGreaterEqual(hv.MAINTENANCE_RECEIPT_STALE_S,900+max(r['maintenance_last.elapsed_ms'] for r in ROWS)/1000)
  for row in ROWS:
   m=maintenance_at(row,hv.MAINTENANCE_RECEIPT_STALE_S)
   self.assertEqual(m['state'],'observed',row['sample'])
   self.assertEqual(m['semantic_state'],'degraded')
  # transactions.runtime : âge max 824,7 s, reste « degraded » (état réel du propriétaire).
  self.assertLess(max(r['transaction_health.age_s'] for r in ROWS),hv.MAINTENANCE_RECEIPT_STALE_S)

 def test_repeated_failures_uses_owner_window(self):
  end=W['transactionFailuresAtEnd'];ref=end['checked_at']
  failures={f"{f['channel']}|{f['signature']}":{'count':f['count'],'last_seen':ref-f['minutesSinceLastSeen']*60} for f in end['failures']}
  td={'checked_at':ref,'failures':failures}
  self.assertEqual(hv.repeated_failures(td),sum(f['countedByOwner_window3600s_countGe2'] for f in end['failures']))
  self.assertEqual(hv.repeated_failures(td),1)
  self.assertEqual(sum(f['countedByVerdictReason_countGe2_noWindow'] for f in end['failures']),3,'ancien calcul de la capture')

 def _replay(self,states):
  prev=None;out=[]
  for i,st in enumerate(states):
   old=hv.NOW;hv.NOW=1000.0+60*i
   try:
    caps={'control_plane.maintenance':hv.item(st,True,reason='r')}
    hv.apply_hysteresis(caps,prev)
    prev={'generated_at':int(hv.NOW),'capabilities':caps}
    out.append(caps['control_plane.maintenance']['state'])
   finally:hv.NOW=old
  return out

 def test_hysteresis_two_consecutive_readings(self):
  self.assertEqual(self._replay(['healthy','degraded','healthy']),['healthy','healthy','healthy'])
  self.assertEqual(self._replay(['healthy','degraded','degraded','healthy']),['healthy','healthy','degraded','healthy'])
  self.assertEqual(self._replay(['healthy','stale','degraded']),['healthy','healthy','degraded'])
  self.assertEqual(self._replay(['healthy','down']),['healthy','down'],'down jamais retardé')

 def test_captured_window_unchanged_by_hysteresis(self):
  # Sur la fenêtre réelle les deux composants sont non sains dès le 1er relevé : 16/18 reste
  # affiché (l'hystérésis ne masque pas un état durable).
  seq=['degraded' if r['cap.control_plane.maintenance.state']!='healthy' else 'healthy' for r in ROWS]
  out=self._replay(seq)
  self.assertEqual(out[1:],seq[1:])

 def test_no_previous_or_old_previous_publishes_raw(self):
  caps={'x':hv.item('degraded',True)}
  hv.apply_hysteresis(caps,None);self.assertEqual(caps['x']['state'],'degraded')
  with tempfile.TemporaryDirectory() as td:
   p=Path(td)/'current.json'
   p.write_text(json.dumps({'generated_at':hv.NOW-301,'capabilities':{'x':{'state':'healthy'}}}))
   self.assertIsNone(hv.previous_verdict(p))
   p.write_text(json.dumps({'generated_at':hv.NOW-60,'capabilities':{'x':{'state':'healthy'}}}))
   self.assertIsNotNone(hv.previous_verdict(p))
   p.write_text('{corrupt')
   self.assertIsNone(hv.previous_verdict(p))

if __name__=='__main__':unittest.main()
