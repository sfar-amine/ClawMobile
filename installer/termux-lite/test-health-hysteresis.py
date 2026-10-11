"""F5 regression evidence for the canonical health owner, using S24 #131."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('verdict',Path(__file__).with_name('health-verdict.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
FIXTURE=ROOT/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11b/f5/health-correlated-window.json'
class Hysteresis(unittest.TestCase):
 def test_real_window_has_no_mechanical_stale_and_keeps_degradation(self):
  data=json.loads(FIXTURE.read_text())
  self.assertEqual(v.MAINTENANCE_CADENCE_S,data['maintenanceJob']['schedule']['everyMs']/1000)
  with tempfile.TemporaryDirectory() as directory:
   owner=Path(directory);receipt=owner/'autonomous-engineering/maintenance-last.json';receipt.parent.mkdir()
   for values in data['samples']['rows']:
    row=dict(zip(data['samples']['columns'],values))
    receipt.write_text(json.dumps({'checked_at':row['maintenance_last.checked_at'],'task_health':{},'semantic_health':{'state':'attention_required','attention':[{'component':'transaction_health'}]}}))
    with patch.object(v,'OC',owner),patch.object(v,'NOW',row['verdict.generated_at']):
     observed=v.maintenance_view()
    self.assertEqual(observed['state'],'observed')
    self.assertEqual(observed['semantic_state'],'degraded')
    self.assertLess(row['transaction_health.age_s'],v.MAINTENANCE_RECEIPT_STALE_S)
 def test_two_attention_observations_and_immediate_recovery_or_down(self):
  previous={'capabilities':{'transactions.runtime':{'state':'healthy'}}}
  first={'transactions.runtime':{'state':'degraded','reason':'real_failure'}}
  v.apply_hysteresis(first,previous)
  self.assertEqual(first['transactions.runtime']['state'],'healthy')
  self.assertEqual(first['transactions.runtime']['observed_state'],'degraded')
  self.assertEqual(first['transactions.runtime']['pending_attention']['reason'],'real_failure')
  second={'transactions.runtime':{'state':'degraded','reason':'real_failure'}}
  v.apply_hysteresis(second,{'capabilities':first})
  self.assertEqual(second['transactions.runtime']['state'],'degraded')
  for state in ('healthy','down'):
   caps={'transactions.runtime':{'state':state}}
   v.apply_hysteresis(caps,{'capabilities':second})
   self.assertEqual(caps['transactions.runtime']['state'],state)
 def test_previous_receipt_freshness_and_missing_evidence(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'current.json'
   with patch.object(v,'NOW',1000):
    for stamp,valid in ((700,True),(699,False),(1001,False)):
     path.write_text(json.dumps({'generated_at':stamp,'capabilities':{'transactions.runtime':{'state':'healthy'}}}))
     self.assertEqual(v.previous_verdict(path) is not None,valid)
  caps={'transactions.runtime':{'state':'degraded'}}
  v.apply_hysteresis(caps,None)
  self.assertEqual(caps['transactions.runtime']['state'],'degraded')
 def test_real_failure_count_uses_receipt_owner_time(self):
  data=json.loads(FIXTURE.read_text())['transactionFailuresAtEnd'];reference=data['checked_at']
  failures={row['signature']+str(i):{'count':row['count'],'last_seen':reference-row['minutesSinceLastSeen']*60} for i,row in enumerate(data['failures'])}
  with patch.object(v,'NOW',reference+86400):
   self.assertEqual(v.repeated_failures({'checked_at':reference,'failures':failures}),1)
if __name__=='__main__':unittest.main()
