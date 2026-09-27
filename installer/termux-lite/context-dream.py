#!/data/data/com.termux/files/usr/bin/python3
import datetime,hashlib,json,os,pathlib,sqlite3,uuid
H=pathlib.Path.home(); D=pathlib.Path(os.environ.get('SAMANTHA_CONTEXT_ROOT',H/'.openclaw/context-sync')); DB=D/'memory.db'
def norm(t): return ' '.join(t.lower().split())
def main():
 c=sqlite3.connect(DB,timeout=30); c.execute('PRAGMA busy_timeout=30000')
 c.execute("CREATE TABLE IF NOT EXISTS dream_proposals(proposal_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,action TEXT NOT NULL,source_ids TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',created_at TEXT NOT NULL,applied_at TEXT)")
 rows=c.execute('SELECT id,revision,surface,kind,text,created_at,supersedes FROM events ORDER BY revision').fetchall()
 active={r[0]:r for r in rows}; superseded={r[6] for r in rows if r[6]}
 for x in superseded: active.pop(x,None)
 run_id=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]; props=[]
 def propose(action,ids,payload):
  ids=sorted(set(ids)); canonical=json.dumps({'action':action,'source_ids':ids,'payload':payload},sort_keys=True,ensure_ascii=False,separators=(',',':')); pid=hashlib.sha256(canonical.encode()).hexdigest()
  c.execute("INSERT OR IGNORE INTO dream_proposals(proposal_id,run_id,action,source_ids,payload,status,created_at) VALUES(?,?,?,?,?,'proposed',?)",(pid,run_id,action,json.dumps(ids,separators=(',',':')),json.dumps(payload,ensure_ascii=False,separators=(',',':')),datetime.datetime.now(datetime.timezone.utc).isoformat()))
  if c.execute('SELECT changes()').fetchone()[0]: props.append({'proposalId':pid,'action':action,'sourceIds':ids,'payload':payload})
 groups={}
 for r in active.values(): groups.setdefault((r[3],norm(r[4])),[]).append(r)
 for (kind,text),g in groups.items():
  if len(g)>1: propose('consolidate_duplicate',[x[0] for x in g],{'kind':kind,'normalizedText':text})
 for r in rows:
  if r[6]: propose('confirm_supersession',[r[6],r[0]],{'superseded':r[6],'replacement':r[0]})
 c.commit()
 print(json.dumps({'runId':run_id,'mode':'shadow','eventsScanned':len(rows),'newProposals':len(props),'proposals':props},ensure_ascii=False,separators=(',',':')))
if __name__=='__main__': main()
