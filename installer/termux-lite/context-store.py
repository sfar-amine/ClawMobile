#!/data/data/com.termux/files/usr/bin/python3
import datetime,json,os,pathlib,sqlite3,sys
H=pathlib.Path.home()
D=pathlib.Path(os.environ.get("SAMANTHA_CONTEXT_ROOT",H/".openclaw/context-sync"))
DB=D/"memory.db"
SCHEMA_VERSION=2

def connect():
    D.mkdir(parents=True,exist_ok=True); os.chmod(D,0o700)
    c=sqlite3.connect(DB,timeout=30,isolation_level=None)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=30000")
    return c

def migrate(c):
    c.execute("BEGIN IMMEDIATE")
    try:
        c.execute("CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,surface TEXT,kind TEXT,text TEXT,created_at TEXT,ingested_at TEXT,supersedes TEXT)")
        cols={r[1] for r in c.execute("PRAGMA table_info(events)")}
        if "supersedes" not in cols: c.execute("ALTER TABLE events ADD COLUMN supersedes TEXT")
        if "revision" not in cols: c.execute("ALTER TABLE events ADD COLUMN revision INTEGER")
        c.execute("CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        c.execute("""CREATE TABLE IF NOT EXISTS session_cursors(
            session_id TEXT PRIMARY KEY,surface TEXT NOT NULL,last_seen_revision INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS dream_proposals(
            proposal_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,action TEXT NOT NULL,
            source_ids TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',
            created_at TEXT NOT NULL,applied_at TEXT)""")
        missing=c.execute("SELECT rowid FROM events WHERE revision IS NULL ORDER BY created_at,rowid").fetchall()
        head=c.execute("SELECT COALESCE(MAX(revision),0) FROM events").fetchone()[0]
        for (rowid,) in missing:
            head+=1; c.execute("UPDATE events SET revision=? WHERE rowid=?",(head,rowid))
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_revision ON events(revision)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at)")
        c.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('schema_version',?)",(str(SCHEMA_VERSION),))
        c.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('current_revision',?)",(str(head),))
        c.execute("COMMIT")
        return head
    except Exception:
        c.execute("ROLLBACK"); raise

def head(c):
    migrate(c)
    return int(c.execute("SELECT value FROM memory_meta WHERE key='current_revision'").fetchone()[0])

def delta(c,after,limit=500):
    h=head(c); after=max(0,int(after)); limit=max(1,min(int(limit),5000))
    rows=c.execute("""SELECT id,revision,surface,kind,text,created_at,supersedes
                      FROM events WHERE revision>? ORDER BY revision LIMIT ?""",(after,limit)).fetchall()
    return {"changed":h>after,"fromRevision":after,"toRevision":h,"events":[
        {"id":r[0],"revision":r[1],"surface":r[2],"kind":r[3],"text":r[4],"createdAt":r[5],"supersedes":r[6]}
        for r in rows],"truncated": bool(rows and rows[-1][1] < h)}

def ingest_file(c,path):
    p=pathlib.Path(path)
    if not p.exists():
        alt=D/'processed'/p.name
        if alt.exists(): p=alt
        else: raise FileNotFoundError(path)
    e=json.loads(p.read_text())
    if not all(e.get(k) for k in ('id','surface','kind','text','createdAt')): raise ValueError('missing required field')
    if e['surface'] not in ('chat','work','voice','openclaw'): raise ValueError('bad surface')
    if e['kind'] not in ('decision','learning','open_thread','completed_action','constraint','checkpoint'): raise ValueError('bad kind')
    migrate(c); c.execute('BEGIN IMMEDIATE')
    try:
        row=c.execute('SELECT revision FROM events WHERE id=?',(e['id'],)).fetchone()
        if row: rev=row[0]; inserted=False
        else:
            h=int(c.execute("SELECT value FROM memory_meta WHERE key='current_revision'").fetchone()[0]); rev=h+1
            now=datetime.datetime.now(datetime.timezone.utc).isoformat()
            c.execute('INSERT INTO events(id,surface,kind,text,created_at,ingested_at,supersedes,revision) VALUES(?,?,?,?,?,?,?,?)',(e['id'],e['surface'],e['kind'],' '.join(str(e['text']).split()),e['createdAt'],now,e.get('supersedes'),rev))
            c.execute("UPDATE memory_meta SET value=? WHERE key='current_revision'",(str(rev),)); inserted=True
        c.execute('COMMIT')
    except Exception:
        c.execute('ROLLBACK'); raise
    processed=D/'processed'; history=D/'history'; processed.mkdir(parents=True,exist_ok=True); history.mkdir(parents=True,exist_ok=True)
    if inserted:
        e['revision']=rev; ap=history/(datetime.datetime.now().astimezone().strftime('%Y-%m')+'.jsonl')
        with ap.open('a') as f: f.write(json.dumps(e,ensure_ascii=False,separators=(',',':'))+'\n')
        os.chmod(ap,0o600)
    dest=processed/p.name
    if p.exists(): os.replace(p,dest)
    return {'id':e['id'],'revision':rev,'inserted':inserted}

def cursor(c,sid,surface=None,advance=None):
    migrate(c); now=datetime.datetime.now(datetime.timezone.utc).isoformat()
    row=c.execute("SELECT surface,last_seen_revision,updated_at FROM session_cursors WHERE session_id=?",(sid,)).fetchone()
    if advance is not None:
        rev=int(advance); h=head(c)
        if rev<0 or rev>h: raise ValueError("cursor revision outside memory head")
        sf=surface or (row[0] if row else "chat")
        c.execute("""INSERT INTO session_cursors(session_id,surface,last_seen_revision,updated_at) VALUES(?,?,?,?)
                     ON CONFLICT(session_id) DO UPDATE SET surface=excluded.surface,last_seen_revision=excluded.last_seen_revision,updated_at=excluded.updated_at""",
                  (sid,sf,rev,now))
        row=(sf,rev,now)
    return {"sessionId":sid,"surface":row[0],"lastSeenRevision":row[1],"updatedAt":row[2]} if row else None

def main():
    c=connect(); cmd=sys.argv[1] if len(sys.argv)>1 else "head"
    if cmd=="migrate": print(json.dumps({"schemaVersion":SCHEMA_VERSION,"head":migrate(c)},separators=(",",":")))
    elif cmd=="head": print(head(c))
    elif cmd=="delta":
        if len(sys.argv)<3: raise SystemExit("usage: context-store.py delta AFTER [LIMIT]")
        print(json.dumps(delta(c,sys.argv[2],sys.argv[3] if len(sys.argv)>3 else 500),ensure_ascii=False,separators=(",",":")))
    elif cmd=="check":
        if len(sys.argv)<3: raise SystemExit("usage: context-store.py check AFTER [LIMIT]")
        print(json.dumps(delta(c,sys.argv[2],sys.argv[3] if len(sys.argv)>3 else 500),ensure_ascii=False,separators=(",",":")))
    elif cmd=="ingest-file":
        if len(sys.argv)<3: raise SystemExit("usage: context-store.py ingest-file EVENT_JSON")
        print(json.dumps(ingest_file(c,sys.argv[2]),separators=(",",":")))
    elif cmd=="cursor-get":
        if len(sys.argv)<3: raise SystemExit("usage: context-store.py cursor-get SESSION_ID")
        print(json.dumps(cursor(c,sys.argv[2]),separators=(",",":")))
    elif cmd=="cursor-set":
        if len(sys.argv)<5: raise SystemExit("usage: context-store.py cursor-set SESSION_ID SURFACE REVISION")
        print(json.dumps(cursor(c,sys.argv[2],sys.argv[3],sys.argv[4]),separators=(",",":")))
    else: raise SystemExit(f"unknown command: {cmd}")
if __name__=="__main__": main()
