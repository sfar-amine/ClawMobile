import importlib.util
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('latency', Path(__file__).with_name('voice-m1-analyze.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def event(sid, src, ev, ms, x=None, turn=0):
    return dict(sid=sid, src=src, turn=turn, ev=ev, boot_ns=int(ms*1000000), x=x or {})

class LatencyTests(unittest.TestCase):
    def test_hundred_source_joined_sessions(self):
        rows = []
        for i in range(100):
            for src, ev, ms in [('app','t00',0),('companion','t01',10),('companion','t07',30),('app','t07c',40)]:
                rows.append(event(str(i),src,ev,ms))
            rows.append(event(str(i),'app','t01',1))  # Wrong producer never wins.
        values = module.analyze(rows)['startup']['metrics']
        self.assertEqual(values['t00_to_t01_ms']['p50_ms'],10)
        self.assertEqual(values['t01_to_t07_ms']['p95_ms'],20)
        self.assertEqual(values['t00_to_t07c_ms']['p95_ms'],40)
    def test_drift_invalidates_whole_sid(self):
        rows = [event('bad','app','t00',0),event('bad','app','t07c',10),event('bad','companion','t99',20,{'clock_drift_us':1001})]
        r = module.analyze(rows)['startup']
        self.assertEqual(r['metrics']['prewarm_app_ms']['n'],0)
        self.assertEqual(r['clock_drift_excluded_sessions'],['bad'])
    def test_no_cross_session_pair(self):
        rows = [event('a','app','t00',0),event('b','companion','t01',10)]
        r = module.analyze(rows)['startup']['metrics']['t00_to_t01_ms']
        self.assertEqual(r['n'],0)
        self.assertIsNone(r['p95_ms'])
    def test_small_sample_is_marked(self):
        r = module.analyze([event('a','app','t00',0),event('a','app','t07c',10)])['startup']['metrics']['prewarm_app_ms']
        self.assertEqual(r['p50_ms'],10)
        self.assertFalse(r['p95_qualified'])
        self.assertEqual(r['observed_p95_ms'],10)
        self.assertIsNone(r['p95_ms'])

    def test_explicit_untruncated_boundary_and_legacy_unknown(self):
        rows = []
        for sid, drift, metadata in [('below',999.999,False),('equal',1000,False),('above',1000.001,False),('negative',-1000.001,False),('legacy',1000,None)]:
            rows += [event(sid,'app','t00',0),event(sid,'companion','t01',1),event(sid,'companion','t07',2),event(sid,'app','t07c',3)]
            x = {'clock_drift_us':drift}
            if metadata is not None: x['clock_drift_truncated'] = metadata
            rows.append(event(sid,'companion','t99',4,x))
        r = module.analyze(rows)['startup']
        self.assertEqual(r['metrics']['t01_to_t07_ms']['n'],2)
        self.assertEqual(r['clock_drift_excluded_sessions'],['above','legacy','negative'])
        self.assertEqual(r['clock_drift_unknown_boundary_sessions'],['legacy'])
    def test_empty_report_has_no_invented_percentiles(self):
        r = module.analyze([])['startup']['metrics']['t01_to_t07_ms']
        self.assertEqual(r['n'],0)
        self.assertNotIn('p50_ms',r)
        self.assertIsNone(r['p95_ms'])
    def test_turn_and_producer_are_exact(self):
        bad = event('a','companion','t07',30); bad['turn'] = 1
        rows = [event('a','app','t00',0),event('a','app','t01',1),bad,event('a','app','t07c',40)]
        self.assertEqual(module.analyze(rows)['startup']['metrics']['t01_to_t07_ms']['n'],0)

    def test_prewarm_guard_counts_explicit_hit_and_miss(self):
        rows = [event('warm','companion','t07',1,{'cached':True}),
                event('cold','companion','t07',1,{'cached':False}),
                event('legacy','companion','t07',1)]
        self.assertEqual(module.analyze(rows)['startup']['prewarm_guard'],
                         {'observed':3,'warm_hits':1,'warm_misses':1,'missing_outcome':1})

    def test_pipeline_reports_complete_result_audio_and_budget_breach(self):
        complete={'phase':1,'decision_ms':100,'capability_ms':2900,'gemini_ms':400,
                  'response_ms':4200,'budget_ms':5000,'budget_exceeded':False,'warm_hit':True}
        slow={**complete,'response_ms':5100,'budget_exceeded':True}
        waiting={'phase':0,'gemini_ms':200,'warm_hit':True}
        rows=[event('a','companion','t30p',4.2,complete,1),event('b','companion','t30p',5.1,slow,1),
              event('a','companion','t30p',.2,waiting,1)]
        report=module.analyze(rows)['pipeline']
        self.assertEqual(report['result_audio_samples'],2)
        self.assertEqual(report['complete_samples'],2)
        self.assertEqual(report['under_budget_samples'],1)
        self.assertEqual(report['budget_breaches'],1)
        self.assertEqual(report['metrics']['capability_ms']['p50_ms'],2900)
        self.assertEqual(report['qualification'],'physical_s24_recipe_required')

if __name__ == '__main__': unittest.main()
