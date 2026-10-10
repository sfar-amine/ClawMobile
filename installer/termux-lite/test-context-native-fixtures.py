"""Real sanitized S24 payloads; synthesized bounds/coverage cases labelled."""
import datetime,json,sqlite3,tempfile,unittest
from pathlib import Path
from context_native_metrics import read_native_metrics
from context_digest import close_supersessions,bridge_digest
ROOT=Path(__file__).resolve().parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/c10'
class NativeFixtures(unittest.TestCase):
 def test_native_real_schema_events_and_unknown_promotion_semantics(self):
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
   # it is an additional fully captured event.
   with sqlite3.connect(path) as conn:
    conn.execute('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?,NULL)',('memory-core','memory-host.events','coverage-anchor',json.dumps({'event':{'type':'coverage-anchor','timestamp':fixture['memoryHostEventsLast7d']['firstEventEver']}}),0))
   before=path.read_bytes();result=read_native_metrics(path,now)
   self.assertEqual(result['memoryRecallCount'],77);self.assertEqual(result['nativeDeepRuns7d'],21)
   self.assertIsNone(result['deepPromotions7d']);self.assertFalse(result['deepPromotionsWindowComplete'])
   self.assertGreater(result['nativeDeepLines7d'],0);self.assertEqual(path.read_bytes(),before)
   self.assertNotIn('@',json.dumps(result));self.assertNotIn('query',json.dumps(result))
   with sqlite3.connect(path) as conn:
    conn.executemany('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?,NULL)',(('memory-core','memory-host.events',str(i),'{}',0) for i in range(10001)))
   self.assertEqual(read_native_metrics(path,now)['nativeMetricsState'],'owner_volume_unverified')
 def test_real_memory_events_supersession_links_and_digest(self):
  fixture=json.loads((ROOT/'memory-events-200.json').read_text());now=datetime.datetime(2026,10,10,12,5,tzinfo=datetime.timezone.utc)
  with tempfile.TemporaryDirectory() as root,sqlite3.connect(':memory:') as conn:
   for schema in fixture['schema'].values():conn.execute(schema)
   for row in fixture['events']:
    keys=('id','surface','kind','text','created_at','ingested_at','supersedes','revision','session_id')
    conn.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)',[row[k] for k in keys])
   for row in fixture['dream_proposals_sample']:
    keys=('proposal_id','run_id','action','source_ids','payload','status','created_at','applied_at')
    values=[json.dumps(row[k]) if k in ('source_ids','payload') else row[k] for k in keys]
    conn.execute('INSERT INTO dream_proposals VALUES(?,?,?,?,?,?,?,?)',values)
   count=conn.execute("SELECT count(*) FROM dream_proposals WHERE action='confirm_supersession'").fetchone()[0]
   self.assertGreater(count,0);self.assertEqual(close_supersessions(conn,now),count);self.assertEqual(close_supersessions(conn,now),0)
   result=bridge_digest(conn,Path(root)/'workspace',now)
   self.assertIn(result['state'],('bridged','no_digest'))
if __name__=='__main__':unittest.main()
