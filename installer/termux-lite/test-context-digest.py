"""Synthetic owner schema tests; installed 200-event fixture is still required."""
import contextlib,io,runpy,datetime,hashlib,importlib.util,json,os,sqlite3,tempfile,unittest,subprocess,sys
from pathlib import Path
from unittest.mock import patch
from context_digest import bridge_digest,close_supersessions,MAX_BYTES,MAX_FILES
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('digest_store',HERE/'context-store.py');store=importlib.util.module_from_spec(spec);spec.loader.exec_module(store)
NOW=datetime.datetime(2026,10,10,12,5,tzinfo=datetime.timezone.utc) # existing13:05 Tunis cycle
class DigestTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.workspace=self.root/'workspace';self.conn=sqlite3.connect(self.root/'memory.db',isolation_level=None);store.migrate(self.conn)
 def tearDown(self):self.conn.close();self.tmp.cleanup()
 def event(self,n,text='Décision source non sensible',kind='decision',supersedes=None):
  identifier=hashlib.sha256(('fixture-event-'+str(n)).encode()).hexdigest();self.conn.execute('INSERT INTO events(id,revision,surface,kind,text,created_at,supersedes) VALUES(?,?,?,?,?,?,?)',(identifier,n,'chat',kind,text,NOW.isoformat(),supersedes))
  root=self.conn.execute('SELECT root_event_id FROM curated_facts WHERE event_id=?',(supersedes,)).fetchone() if supersedes else None
  self.conn.execute("INSERT INTO curated_facts(event_id,root_event_id,valid_from,valid_to,observed_at,state) VALUES(?,?,?,NULL,?,'active')",(identifier,root[0] if root else identifier,NOW.isoformat(),NOW.isoformat()));return identifier
 def proposal(self,n,ids,action='memory_digest',payload=None):
  identifier=hashlib.sha256(('fixture-proposal-'+str(n)).encode()).hexdigest();self.conn.execute('INSERT INTO dream_proposals(proposal_id,run_id,action,source_ids,payload,status,created_at) VALUES(?,?,?,?,?,?,?)',(identifier,'fixture',action,json.dumps(ids),json.dumps(payload or {}),'proposed',NOW.isoformat()));return identifier
 def create(self,count=80):
  ids=[self.event(n) for n in range(1,count+1)]
  for n in range(0,len(ids),24):self.proposal(n,ids[n:n+24])
  return ids
 def note(self):return (self.workspace/'memory/cross-surface/2026-10-10.md').read_bytes()
 def test_android_denied_root_walks_from_home(self):
  # S24 12/10: os.open('/') -> PermissionError on Android; HOME anchors the descriptor walk.
  import context_digest
  real=os.open
  def guarded(path,*a,**k):
   if path=='/':raise PermissionError(13,'Permission denied','/')
   return real(path,*a,**k)
  with patch.dict(os.environ,{'HOME':str(self.root)}),patch('context_digest.os.open',side_effect=guarded):
   fd=context_digest._directory(self.root/'workspace/memory/cross-surface');os.close(fd)
   self.assertTrue((self.root/'workspace/memory/cross-surface').is_dir())
   with self.assertRaises(PermissionError):context_digest._directory(Path(tempfile.gettempdir())/'outside-home-x')
 def test_android_without_os_link_writes_the_daily_note(self):
  # S24 12/10: Termux Python has no os.link; the fsynced temporary is renamed instead.
  import context_digest
  self.create()
  saved=context_digest.os.link
  try:
   del context_digest.os.link
   result=bridge_digest(self.conn,self.workspace,NOW)
  finally:
   context_digest.os.link=saved
  self.assertEqual(result['state'],'bridged');self.assertIn(b'non normatifs',self.note())
  self.assertEqual([p.name for p in (self.workspace/'memory/cross-surface').iterdir()],['2026-10-10.md'])
 def test_108_existing_supersessions_closed_once_without_event_change(self):
  for n in range(1,109):
   old=self.event(n);new=self.event(n+108,supersedes=old);self.proposal(n,[old,new],'confirm_supersession',{'replacement':new,'superseded':old})
  before=self.conn.execute('SELECT * FROM events').fetchall();self.assertEqual(close_supersessions(self.conn,NOW),108);self.assertEqual(close_supersessions(self.conn,NOW),0);self.assertEqual(self.conn.execute('SELECT * FROM events').fetchall(),before)
  self.assertEqual(self.conn.execute("SELECT count(*) FROM dream_proposals WHERE status='applied' AND json_extract(payload,'$.reason')='author_declared_supersession'").fetchone()[0],108)
 def test_invalid_author_link_remains_unapplied(self):
  old=self.event(1);new=self.event(2);self.proposal(1,[old,new],'confirm_supersession',{'replacement':new,'superseded':old});self.assertEqual(close_supersessions(self.conn,NOW),0)
 def test_2000_events_exact_bounds_and_idempotence(self):
  self.create(2100);before=self.conn.execute('SELECT * FROM events').fetchall();first=bridge_digest(self.conn,self.workspace,NOW);body=self.note();second=bridge_digest(self.conn,self.workspace,NOW)
  self.assertLessEqual(first['elementsLinked'],60);self.assertLessEqual(len(body),MAX_BYTES);self.assertEqual(body,self.note());self.assertEqual(second['state'],'unchanged');self.assertEqual(second['newElementsLinked'],0);self.assertEqual(before,self.conn.execute('SELECT * FROM events').fetchall());self.assertEqual(os.stat(self.workspace/'memory/cross-surface/2026-10-10.md').st_mode&0o777,0o600);self.assertIn('non normatifs',body.decode())
 def test_replaced_secret_and_payment_values_never_written(self):
  original=self.event(1,'OBSOLETE_TEXT');replacement=self.event(2,'Contrainte actuelle',kind='constraint',supersedes=original)
  secrets=[self.event(3,'sk-aaaaaaaaaaaaaaaaaaaa'),self.event(4,'ghp_'+'b'*25),self.event(5,'Code 123456'),self.event(6,'eyJaaaa.bbbbb.ccccc'),self.event(7,'Paiement carte 1122334455667788 et 99 TND')]
  self.proposal(1,[original,replacement,*secrets]);result=bridge_digest(self.conn,self.workspace,NOW);body=self.note().decode();self.assertEqual(result['elementsLinked'],1);self.assertIn(replacement,body)
  for forbidden in ['OBSOLETE_TEXT','sk-','ghp_','123456','eyJ','99 TND','1122334455667788']:self.assertNotIn(forbidden,body)
 def test_rotation_keeps_exact_30_owned_dates_other_files_preserved(self):
  self.create();directory=self.workspace/'memory/cross-surface';directory.mkdir(parents=True);(directory/'operator.txt').write_text('preserve')
  for n in range(1,32):(directory/((NOW.date()-datetime.timedelta(days=n)).isoformat()+'.md')).write_text('old')
  bridge_digest(self.conn,self.workspace,NOW);self.assertEqual(len(list(directory.glob('*.md'))),MAX_FILES);self.assertTrue((directory/'operator.txt').exists())
 def test_before22_only_and_no_digest_no_files(self):
  self.assertEqual(bridge_digest(self.conn,self.workspace,NOW)['state'],'no_digest');self.assertFalse(self.workspace.exists());self.create();late=NOW.replace(hour=21);self.assertEqual(bridge_digest(self.conn,self.workspace,late)['state'],'missed_window');self.assertFalse(self.workspace.exists())
 def test_only_audited_active_facts_enter_cross_surface_projection(self):
  included=self.event(1,'Fait audité indexable');excluded=self.event(2,'Fait non audité')
  self.conn.execute('DELETE FROM curated_facts WHERE event_id=?',(excluded,));self.proposal(1,[included,excluded])
  dreaming=self.workspace/'memory/dreaming/deep/2026-10-10.md';dreaming.parent.mkdir(parents=True);dreaming.write_text('Texte dreaming à exclure')
  bridge_digest(self.conn,self.workspace,NOW);body=self.note().decode()
  self.assertIn('Fait audité indexable',body);self.assertNotIn('Fait non audité',body);self.assertNotIn('Texte dreaming',body)
 def test_file_written_before_owner_commit_recovers_exactly(self):
  self.create();self.conn.execute('BEGIN');first=bridge_digest(self.conn,self.workspace,NOW);body=self.note();self.conn.execute('ROLLBACK');self.assertEqual(self.conn.execute("SELECT count(*) FROM dream_proposals WHERE status='bridged'").fetchone()[0],0)
  second=bridge_digest(self.conn,self.workspace,NOW);self.assertEqual(first['sha256'],second['sha256']);self.assertEqual(body,self.note())
 def test_foreign_collision_refused_without_acknowledgement(self):
  self.create();directory=self.workspace/'memory/cross-surface';directory.mkdir(parents=True);(directory/'2026-10-10.md').write_text('foreign');(directory/'2026-10-10.md').chmod(0o600)
  with self.assertRaisesRegex(ValueError,'collision'):bridge_digest(self.conn,self.workspace,NOW)
  self.assertEqual((directory/'2026-10-10.md').read_text(),'foreign');self.assertEqual(self.conn.execute("SELECT count(*) FROM dream_proposals WHERE status='bridged'").fetchone()[0],0)
 def test_existing_note_with_unsafe_permissions_is_not_acknowledged(self):
  self.create();bridge_digest(self.conn,self.workspace,NOW);note=self.workspace/'memory/cross-surface/2026-10-10.md';note.chmod(0o644)
  with self.assertRaisesRegex(ValueError,'file_unavailable'):bridge_digest(self.conn,self.workspace,NOW)
  self.assertEqual(note.stat().st_mode&0o777,0o644)
 def test_crash_recovery_rejects_hardlinked_exact_note(self):
  self.create();self.conn.execute('BEGIN');bridge_digest(self.conn,self.workspace,NOW);self.conn.execute('ROLLBACK');note=self.workspace/'memory/cross-surface/2026-10-10.md';os.link(note,self.root/'foreign-link')
  with self.assertRaisesRegex(ValueError,'file_unavailable'):bridge_digest(self.conn,self.workspace,NOW)
  self.assertEqual(self.conn.execute("SELECT count(*) FROM dream_proposals WHERE status='bridged'").fetchone()[0],0)
 def test_symlink_parent_and_target_refused(self):
  self.create();outside=self.root/'foreign';outside.mkdir();self.workspace.mkdir();(self.workspace/'memory').symlink_to(outside)
  with self.assertRaises(OSError):bridge_digest(self.conn,self.workspace,NOW)
  self.assertEqual(list(outside.iterdir()),[])
 def test_future_note_prevents_deleting_current_projection(self):
  self.create();directory=self.workspace/'memory/cross-surface';directory.mkdir(parents=True);(directory/'2099-01-01.md').write_text('preserve')
  with self.assertRaisesRegex(ValueError,'future_file'):bridge_digest(self.conn,self.workspace,NOW)
  self.assertFalse((directory/'2026-10-10.md').exists());self.assertEqual(self.conn.execute("SELECT count(*) FROM dream_proposals WHERE status='bridged'").fetchone()[0],0)
 def test_unknown_native_metrics_remain_unknown_not_zero(self):
  self.event(1);self.conn.execute('DELETE FROM curated_facts');output=io.StringIO()
  with patch.dict(os.environ,{'SAMANTHA_CONTEXT_ROOT':str(self.root)}), patch('pathlib.Path.home',return_value=self.root), contextlib.redirect_stdout(output):
   runpy.run_path(str(HERE/'context-dream.py'),run_name='__main__')
  result=json.loads(output.getvalue());self.assertIsNone(result['deepPromotions7d']);self.assertIsNone(result['memoryRecallCount']);self.assertEqual(result['nativeMetricsState'],'owner_unavailable')
  persisted=json.loads(self.conn.execute("SELECT value FROM memory_meta WHERE key='curator_last_run_v1'").fetchone()[0]);self.assertIsNone(persisted['deepPromotions7d'])
if __name__=='__main__':unittest.main()
