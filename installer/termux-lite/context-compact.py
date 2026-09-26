#!/data/data/com.termux/files/usr/bin/python3
import datetime,json,os,pathlib,sqlite3,tempfile
H=pathlib.Path.home(); D=pathlib.Path(os.environ.get('SAMANTHA_CONTEXT_ROOT',H/'.openclaw/context-sync'))
Q=D/'pending'; P=D/'processed'; S=D/'state'; A=D/'history'
HY=pathlib.Path(os.environ.get('SAMANTHA_HYBRID_PATH',H/'.openclaw/workspace/context/HYBRID_CONTEXT.md')); DB=D/'memory.db'
for p in (D,Q,P,S,A,HY.parent): p.mkdir(parents=True,exist_ok=True)
os.chmod(D,0o700); con=sqlite3.connect(DB); con.execute('PRAGMA journal_mode=WAL')
con.execute('CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,surface TEXT,kind TEXT,text TEXT,created_at TEXT,ingested_at TEXT,supersedes TEXT)')
cols=[x[1] for x in con.execute('pragma table_info(events)')]
if 'supersedes' not in cols: con.execute('ALTER TABLE events ADD COLUMN supersedes TEXT')
pending=sorted(Q.glob('*.json')); sources=sorted(P.glob('*.json'))+pending; accepted=[]; valid_pending=[]; invalid=[]
for p in sources:
    try:
        e=json.loads(p.read_text())
        if not all(e.get(k) for k in ('id','surface','kind','text','createdAt')): raise ValueError('missing required field')
        if e['surface'] not in ('chat','work','voice','openclaw'): raise ValueError('bad surface')
        if e['kind'] not in ('decision','learning','open_thread','completed_action','constraint','checkpoint'): raise ValueError('bad kind')
        now=datetime.datetime.now(datetime.timezone.utc).isoformat()
        cur=con.execute('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?)',(e['id'],e['surface'],e['kind'],' '.join(str(e['text']).split()),e['createdAt'],now,e.get('supersedes')))
        if cur.rowcount: accepted.append(e)
        if p.parent==Q: valid_pending.append(p)
    except Exception as ex:
        if p.parent==Q: invalid.append((p,str(ex)))
con.commit()
# Archive only newly ingested events.
if accepted:
    ap=A/(datetime.datetime.now().astimezone().strftime('%Y-%m')+'.jsonl')
    with ap.open('a') as f:
        for e in accepted: f.write(json.dumps(e,ensure_ascii=False,separators=(',',':'))+'\n')
    os.chmod(ap,0o600)
# Superseded facts remain in history but are excluded from the current materialized view.
sup=set(r[0] for r in con.execute('select supersedes from events where supersedes is not null and supersedes!=""'))
rows=con.execute('SELECT id,surface,kind,text,created_at FROM events ORDER BY created_at DESC LIMIT 500').fetchall()
caps={'open_thread':12,'decision':18,'constraint':12,'learning':16,'completed_action':12,'checkpoint':6}; groups={k:[] for k in caps}
for r in rows:
    if r[0] in sup: continue
    if r[2] in groups and len(groups[r[2]])<caps[r[2]]: groups[r[2]].append(r)
start='<!-- SAMANTHA_MEMORY_VIEW_START -->'; end='<!-- SAMANTHA_MEMORY_VIEW_END -->'
labels={'open_thread':'Open threads','decision':'Recent decisions','constraint':'Active constraints','learning':'Recent learnings','completed_action':'Recent completed actions','checkpoint':'Recent checkpoints'}
out=[start,'## Bounded cross-surface memory view — '+datetime.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z'),'','> Generated from the durable event store. Full history is retrieved on demand; this view is intentionally bounded.']
for k in caps:
    if groups[k]:
        out+=['','### '+labels[k]]
        for eid,surface,kind,text,created in reversed(groups[k]): out.append(f'- [{surface}/{kind}] {text} <!-- context-event:{eid} -->')
out+=['',end]; block='\n'.join(out)
old=HY.read_text() if HY.exists() else '# Claw Hybrid Conversation Context — Amine\n'
if start in old and end in old:
    pre=old.split(start,1)[0].rstrip(); post=old.split(end,1)[1].lstrip(); new=pre+'\n\n'+block+'\n'+(('\n'+post) if post else '')
else:
    marker='## Cross-surface checkpoint events'; base=old.split(marker,1)[0].rstrip() if marker in old else old.rstrip(); new=base+'\n\n'+block+'\n'
fd,tmp=tempfile.mkstemp(prefix='hybrid.',dir=str(D)); os.close(fd); pathlib.Path(tmp).write_text(new); os.chmod(tmp,0o600); os.replace(tmp,HY)
for p in valid_pending:
    if p.exists(): os.replace(p,P/p.name)
(S/'last_compaction').write_text(datetime.datetime.now().astimezone().isoformat()+'\n')
result={'pending_seen':len(pending),'accepted':len(accepted),'invalid':len(invalid),'indexed':con.execute('select count(*) from events').fetchone()[0],'view_events':sum(map(len,groups.values()))}
print(json.dumps(result,separators=(',',':')))
if invalid:
    for p,e in invalid: print(f'invalid pending event retained: {p.name}: {e}',file=__import__('sys').stderr)
    raise SystemExit(65)
