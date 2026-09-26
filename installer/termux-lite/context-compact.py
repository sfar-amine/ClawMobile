#!/data/data/com.termux/files/usr/bin/python3
import datetime,json,os,pathlib,sqlite3,tempfile
H=pathlib.Path.home(); D=H/'.openclaw/context-sync'; Q=D/'pending'; P=D/'processed'; S=D/'state'; A=D/'history'
HY=H/'.openclaw/workspace/context/HYBRID_CONTEXT.md'; DB=D/'memory.db'
for p in (D,Q,P,S,A): p.mkdir(parents=True,exist_ok=True)
os.chmod(D,0o700); con=sqlite3.connect(DB); con.execute('PRAGMA journal_mode=WAL')
con.execute('CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,surface TEXT,kind TEXT,text TEXT,created_at TEXT,ingested_at TEXT)')
paths=sorted(Q.glob('*.json')); sources=sorted(P.glob('*.json'))+paths; accepted=[]
for p in sources:
    try:
        e=json.loads(p.read_text()); now=datetime.datetime.now(datetime.timezone.utc).isoformat()
        cur=con.execute('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)',(e['id'],e['surface'],e['kind'],' '.join(e['text'].split()),e['createdAt'],now))
        if cur.rowcount: accepted.append(e)
    except Exception: continue
con.commit()
if accepted:
    ap=A/(datetime.datetime.now().astimezone().strftime('%Y-%m')+'.jsonl')
    with ap.open('a') as f:
        for e in accepted: f.write(json.dumps(e,ensure_ascii=False,separators=(',',':'))+'\n')
    os.chmod(ap,0o600)
rows=con.execute('SELECT id,surface,kind,text,created_at FROM events ORDER BY created_at DESC LIMIT 100').fetchall()
caps={'open_thread':12,'decision':18,'constraint':12,'learning':16,'completed_action':12,'checkpoint':6}
groups={k:[] for k in caps}
for r in rows:
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
    pre=old.split(start,1)[0].rstrip(); post=old.split(end,1)[1].lstrip()
    new=pre+'\n\n'+block+'\n'+(('\n'+post) if post else '')
else:
    marker='## Cross-surface checkpoint events'
    base=old.split(marker,1)[0].rstrip() if marker in old else old.rstrip()
    new=base+'\n\n'+block+'\n'
fd,tmp=tempfile.mkstemp(prefix='hybrid.',dir=str(D)); os.close(fd)
pathlib.Path(tmp).write_text(new); os.chmod(tmp,0o600); os.replace(tmp,HY)
for p in paths:
    if p.exists(): os.replace(p,P/p.name)
(S/'last_compaction').write_text(datetime.datetime.now().astimezone().isoformat()+'\n')
print(json.dumps({'pending_seen':len(paths),'accepted':len(accepted),'indexed':con.execute('select count(*) from events').fetchone()[0],'view_events':sum(map(len,groups.values()))},separators=(',',':')))
