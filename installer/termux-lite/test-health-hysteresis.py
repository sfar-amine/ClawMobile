import importlib.util,json,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('verdict',Path(__file__).with_name('health-verdict.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
FIXTURE=ROOT/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11b/f5/health-correlated-window.json'
class Hysteresis(unittest.TestCase):
 def test_real_window_remains_degraded(self):
  data=json.loads(FIXTURE.read_text());previous={};started=time.monotonic()
  for values in data['samples']['rows']:
   row=dict(zip(data['samples']['columns'],values));now=row['verdict.generated_at']
   caps={}
   for key,age in [('control_plane.maintenance','maintenance_last.age_s'),('transactions.runtime','transaction_health.age_s')]:
    self.assertLess(row[age],v.MAINTENANCE_FRESH_S)
    # Both canonical owners reported degraded, including during false stale.
    caps[key]={'state':'degraded','reason':'transaction_health'}
   v.stabilize_components(caps,previous,now)
   self.assertEqual([c['state'] for c in caps.values()],['degraded','degraded'])
   previous={'generated_at':now,'capabilities':caps}
  self.assertLess(time.monotonic()-started,.1)
 def test_two_observations_both_directions_and_hard_failure(self):
  previous={'generated_at':100,'capabilities':{'transactions.runtime':{'state':'healthy','reason':'ok'}}}
  def step(state,now):
   nonlocal previous
   caps={'transactions.runtime':{'state':state,'reason':'observation'}}
   v.stabilize_components(caps,previous,now);previous={'generated_at':now,'capabilities':caps};return caps['transactions.runtime']
  self.assertEqual(step('degraded',160)['state'],'healthy')
  self.assertEqual(step('degraded',220)['state'],'degraded')
  self.assertEqual(step('healthy',280)['state'],'degraded')
  self.assertEqual(step('healthy',340)['state'],'healthy')
  self.assertEqual(step('down',400)['state'],'down')
  self.assertEqual(step('unverified',460)['state'],'unverified')
 def test_stale_previous_does_not_hide_failure(self):
  caps={'transactions.runtime':{'state':'degraded'}}
  v.stabilize_components(caps,{'generated_at':1,'capabilities':{'transactions.runtime':{'state':'healthy'}}},500)
  self.assertEqual(caps['transactions.runtime']['state'],'degraded')
 def test_real_failure_window(self):
  rows=json.loads(FIXTURE.read_text())['transactionFailuresAtEnd']['failures']
  self.assertEqual(sum(r['count']>=2 and 0<=r['minutesSinceLastSeen']*60<=v.TRANSACTION_WINDOW_S for r in rows),1)
if __name__=='__main__':unittest.main()
