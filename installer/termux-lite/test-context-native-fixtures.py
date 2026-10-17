"""Real sanitized S24 payloads; synthesized bounds/coverage cases labelled."""
import datetime,json,sqlite3,tempfile,unittest
from pathlib import Path
from context_native_metrics import read_native_metrics
from context_digest import close_supersessions,bridge_digest
from context_curator import apply_actions
from context_memory import COLUMNS,event
ROOT=Path(__file__).resolve().parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/c10'
class NativeFixtures(unittest.TestCase):
 def test_real_schema_window_rows_and_reconstructed_zero_control(self):
  fixture=json.loads((ROOT/'memory-core-native-7d.json').read_text());now=datetime.datetime.fromisoformat(fixture['_capture']['capturedAt'])
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'native.sqlite'
   with sqlite3.connect(path) as conn:
    conn.execute(fixture['schema'])
    for row in fixture['memoryHostEventsLast7d']['rows']:
     conn.execute('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?,NULL)',('memory-core','memory-host.events',row['entry_key'],json.dumps(row),row['created_at']))
   before=path.read_bytes();partial=read_native_metrics(path,now)
   self.assertEqual(partial['nativeMetricsState'],'owner_window_incomplete')
   # The capture contains an aggregate firstEventEver but only window rows.
   # Reconstruct a minimal historical anchor to test coverage, without claiming
   # it is an additional fully captured event. The resulting zero is a
   # coverage control; the actual installed full-window zero is Claude PR80
   # comment 6102096526, not a fabricated positive event fixture.
   with sqlite3.connect(path) as conn:
    conn.execute('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?,NULL)',('memory-core','memory-host.events','coverage-anchor',json.dumps({'event':{'type':'coverage-anchor','timestamp':fixture['memoryHostEventsLast7d']['firstEventEver']}}),0))
   before=path.read_bytes();result=read_native_metrics(path,now)
   self.assertEqual(result['memoryRecallCount'],77);self.assertEqual(result['nativeDeepRuns7d'],21)
   self.assertEqual(result['deepPromotions7d'],0);self.assertTrue(result['deepPromotionsWindowComplete']);self.assertEqual(result['promotionSemantics'],'applied_including_reconciliations')
   self.assertGreater(result['nativeDeepLines7d'],0);self.assertEqual(path.read_bytes(),before)
   self.assertNotIn('@',json.dumps(result));self.assertNotIn('query',json.dumps(result))
   with sqlite3.connect(path) as conn:
    conn.executemany('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?,NULL)',(('memory-core','memory-host.events',str(i),'{}',0) for i in range(10001)))
   self.assertEqual(read_native_metrics(path,now)['nativeMetricsState'],'owner_volume_unverified')
 def test_applied_sum_including_reconciliations_controls_not_live_capture(self):
  fixture=json.loads((ROOT/'memory-core-native-7d.json').read_text());now=datetime.datetime.fromisoformat(fixture['_capture']['capturedAt'])
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'native.sqlite'
   with sqlite3.connect(path) as conn:
    conn.execute(fixture['schema'])
    rows=[{'type':'coverage-anchor','timestamp':fixture['memoryHostEventsLast7d']['firstEventEver']},
          {'type':'memory.promotion.applied','timestamp':now.isoformat(),'applied':2,'reconciledExisting':2,'query':'never-project'},
          {'type':'memory.promotion.applied','timestamp':(now-datetime.timedelta(days=1)).isoformat(),'applied':3},
          {'type':'memory.promotion.applied','timestamp':(now-datetime.timedelta(days=8)).isoformat(),'applied':99},
          {'type':'memory.promotion.applied','timestamp':(now+datetime.timedelta(days=1)).isoformat(),'applied':88}]
    for i,event in enumerate(rows):conn.execute('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?,NULL)',('memory-core','memory-host.events',str(i),json.dumps({'event':event}),0))
   before=path.read_bytes();out=read_native_metrics(path,now);self.assertEqual(out['deepPromotions7d'],5);self.assertTrue(out['deepPromotionsWindowComplete']);self.assertNotIn('never-project',json.dumps(out));self.assertEqual(path.read_bytes(),before)
   for invalid in [True,-1,'2',1.5,None,1000001]:
    with sqlite3.connect(path) as conn:conn.execute("UPDATE plugin_state_entries SET value_json=? WHERE entry_key='1'",(json.dumps({'event':{'type':'memory.promotion.applied','timestamp':now.isoformat(),'applied':invalid}}),))
    self.assertIsNone(read_native_metrics(path,now)['deepPromotions7d'])
 def test_malformed_window_cannot_publish_zero(self):
  fixture=json.loads((ROOT/'memory-core-native-7d.json').read_text());now=datetime.datetime.fromisoformat(fixture['_capture']['capturedAt'])
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'native.sqlite'
   with sqlite3.connect(path) as conn:
    conn.execute(fixture['schema'])
    conn.execute('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?,NULL)',('memory-core','memory-host.events','anchor',json.dumps({'event':{'type':'coverage-anchor','timestamp':fixture['memoryHostEventsLast7d']['firstEventEver']}}),0))
    conn.execute('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?,NULL)',('memory-core','memory-host.events','broken','not-json',0))
   self.assertIsNone(read_native_metrics(path,now)['deepPromotions7d'])
 def test_real_memory_events_supersession_links_and_digest(self):
  fixture=json.loads((ROOT/'memory-events-200.json').read_text());now=datetime.datetime(2026,10,10,12,5,tzinfo=datetime.timezone.utc)
  with tempfile.TemporaryDirectory() as root,sqlite3.connect(':memory:') as conn:
   for schema in fixture['schema'].values():conn.execute(schema)
   conn.execute("CREATE TABLE curated_facts(event_id TEXT PRIMARY KEY,root_event_id TEXT NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT,observed_at TEXT NOT NULL,state TEXT NOT NULL,invalidated_by TEXT)")
   conn.execute("CREATE TABLE curator_audit(audit_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,action TEXT NOT NULL,event_id TEXT NOT NULL,prior_event_id TEXT,valid_from TEXT NOT NULL,valid_to TEXT,observed_at TEXT NOT NULL)")
   for row in fixture['events']:
    keys=('id','surface','kind','text','created_at','ingested_at','supersedes','revision','session_id')
    conn.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)',[row[k] for k in keys])
   for row in fixture['dream_proposals_sample']:
    keys=('proposal_id','run_id','action','source_ids','payload','status','created_at','applied_at')
    values=[json.dumps(row[k]) if k in ('source_ids','payload') else row[k] for k in keys]
    conn.execute('INSERT INTO dream_proposals VALUES(?,?,?,?,?,?,?,?)',values)
   count=conn.execute("SELECT count(*) FROM dream_proposals WHERE action='confirm_supersession'").fetchone()[0]
   apply_actions(conn,[event(row) for row in conn.execute(f'SELECT {COLUMNS} FROM events e ORDER BY revision')],'fixture',now)
   self.assertGreater(count,0);self.assertEqual(close_supersessions(conn,now),count);self.assertEqual(close_supersessions(conn,now),0)
   result=bridge_digest(conn,Path(root)/'workspace',now)
   self.assertIn(result['state'],('bridged','no_digest'))
if __name__=='__main__':unittest.main()
