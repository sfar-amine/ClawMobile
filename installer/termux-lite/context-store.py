#!/data/data/com.termux/files/usr/bin/python3
import datetime,json,os,pathlib,sqlite3,sys,hashlib,re
from context_memory import ensure_indexes, search, control_items
from context_import import preview as import_preview, selection as import_selection, canonical as import_canonical, PAYMENT as MEMORY_PAYMENT
H=pathlib.Path.home()
D=pathlib.Path(os.environ.get("SAMANTHA_CONTEXT_ROOT",H/".openclaw/context-sync"))
DB=D/"memory.db"
SCHEMA_VERSION=4

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
        if "session_id" not in cols: c.execute("ALTER TABLE events ADD COLUMN session_id TEXT")
        c.execute("CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        c.execute("""CREATE TABLE IF NOT EXISTS session_cursors(
            session_id TEXT PRIMARY KEY,surface TEXT NOT NULL,last_seen_revision INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS dream_proposals(
            proposal_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,action TEXT NOT NULL,
            source_ids TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',
            created_at TEXT NOT NULL,applied_at TEXT)""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_dream_action_status_date ON dream_proposals(action,status,created_at)")
        missing=c.execute("SELECT rowid FROM events WHERE revision IS NULL ORDER BY created_at,rowid").fetchall()
        head=c.execute("SELECT COALESCE(MAX(revision),0) FROM events").fetchone()[0]
        for (rowid,) in missing:
            head+=1; c.execute("UPDATE events SET revision=? WHERE rowid=?",(head,rowid))
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_revision ON events(revision)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at)")
        ensure_indexes(c)
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
    migrate(c); after=max(0,int(after)); limit=max(1,min(int(limit),5000))
    c.execute('BEGIN')
    try:
        h=c.execute('SELECT COALESCE(MAX(revision),0) FROM events').fetchone()[0]
        rows=c.execute("""SELECT id,revision,surface,kind,text,created_at,supersedes
                          FROM events WHERE revision>? AND revision<=? ORDER BY revision LIMIT ?""",(after,h,limit)).fetchall()
    finally: c.execute('COMMIT')
    return {"changed":h>after,"fromRevision":after,"toRevision":h,"events":[
        {"id":r[0],"revision":r[1],"surface":r[2],"kind":r[3],"text":r[4],"createdAt":r[5],"supersedes":r[6]}
        for r in rows],"lastReturnedRevision":rows[-1][1] if rows else after,"truncated": bool(rows and rows[-1][1] < h)}

def ingest_file(c,path,require_active=None):
    p=pathlib.Path(path)
    if not p.exists():
        alt=D/'processed'/p.name
        if alt.exists(): p=alt
        else: raise FileNotFoundError(path)
    e=json.loads(p.read_text())
    if not all(e.get(k) for k in ('id','surface','kind','text','createdAt')): raise ValueError('missing required field')
    if e['surface'] not in ('chat','work','voice','openclaw','claude','codex','app'): raise ValueError('bad surface')
    if e['kind'] not in ('decision','learning','open_thread','completed_action','constraint','checkpoint'): raise ValueError('bad kind')
    session=e.get('sessionId')
    if session is not None and (e['kind']!='open_thread' or not isinstance(session,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',session)):
        raise ValueError('invalid_companion_session')
    migrate(c); c.execute('BEGIN IMMEDIATE')
    try:
        if session is not None and e.get('supersedes'):
            prior=e['supersedes']; seen=set()
            for _ in range(64):
                if prior in seen: raise ValueError('event_origin_chain_invalid')
                seen.add(prior)
                origin=c.execute('SELECT session_id,supersedes,kind FROM events WHERE id=?',(prior,)).fetchone()
                if not origin: break
                if origin[0] is not None and origin[0]!=session: raise ValueError('event_session_conflict')
                if not origin[1]: break
                prior=origin[1]
            else: raise ValueError('event_origin_chain_invalid')
        row=c.execute('SELECT revision,session_id FROM events WHERE id=?',(e['id'],)).fetchone()
        if row:
            if row[1]!=session: raise ValueError('event_session_conflict')
            rev=row[0]; inserted=False
        else:
            if require_active and c.execute('SELECT 1 FROM events WHERE supersedes=?',(require_active,)).fetchone():raise ValueError('memory_already_superseded')
            h=int(c.execute("SELECT value FROM memory_meta WHERE key='current_revision'").fetchone()[0]); rev=h+1
            now=datetime.datetime.now(datetime.timezone.utc).isoformat()
            c.execute('INSERT INTO events(id,surface,kind,text,created_at,ingested_at,supersedes,revision,session_id) VALUES(?,?,?,?,?,?,?,?,?)',(e['id'],e['surface'],e['kind'],' '.join(str(e['text']).split()),e['createdAt'],now,e.get('supersedes'),rev,session))
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

def control_read():
    if DB.is_symlink() or not DB.is_file() or D.is_symlink(): raise ValueError('memory_source_unavailable')
    c=sqlite3.connect(DB.resolve().as_uri()+'?mode=ro',uri=True,timeout=1)
    c.execute('PRAGMA query_only=ON');return c


def forget_probe(c,eid,operation_id):
    if not re.fullmatch(r'[a-f0-9]{64}',eid) or not re.fullmatch(r'[-A-Za-z0-9_.:]{1,128}',operation_id): raise ValueError('invalid_memory_operation')
    text='MEMORY_FORGET_V1 '+json.dumps({'version':1,'operationId':operation_id,'target':eid},sort_keys=True,separators=(',',':'))
    identity=hashlib.sha256(('memory-operation\0'+operation_id).encode()).hexdigest()
    prior=c.execute('SELECT text,supersedes FROM events WHERE id=?',(identity,)).fetchone()
    if prior and (prior[0]!=text or prior[1]!=eid):return {'success':False,'state':'conflict','receipt':None,'error':'memory_operation_conflict'},text,identity
    receipt=c.execute('SELECT revision,created_at FROM events WHERE id=? AND supersedes=?',(identity,eid)).fetchone()
    if receipt:return {'success':True,'state':'forgotten','receipt':{'version':1,'action':'memory.forget','operationId':operation_id,'target':eid,'eventId':identity,'revision':receipt[0],'at':receipt[1]}},text,identity
    row=c.execute('SELECT kind,text FROM events WHERE id=?',(eid,)).fetchone()
    if not row:return {'success':False,'state':'not_found','receipt':None},text,identity
    if not (row[0] in ('decision','constraint') or (row[0]=='learning' and row[1].startswith('MEMORY_IMPORT_V1 '))) or MEMORY_PAYMENT.search(row[1]):
        return {'success':False,'state':'refused','receipt':None},text,identity
    if c.execute('SELECT 1 FROM events WHERE supersedes=?',(eid,)).fetchone():return {'success':True,'state':'already_forgotten','receipt':None},text,identity
    return {'success':False,'state':'ready','receipt':None},text,identity


def control_command(args):
    command=args[0]
    with control_read() as c:
        if command=='control-list':
            query,kind,offset,limit=args[1:]
            result=control_items(c,query,kind or None,int(offset),int(limit))
            result.update(success=True,state='ok',receipt=None)
            headrow=c.execute('SELECT COALESCE(MAX(revision),0), MAX(ingested_at) FROM events').fetchone()
            result.update(revision=headrow[0],updatedAt=headrow[1])
            result['consolidation']={'schedule':'13:00','lastAt':None,'timezone':'Africa/Tunis'}
            return result
        eid,op=args[1:3];result,text,identity=forget_probe(c,eid,op)
    if result['state']!='ready' or command=='control-forget-check':return result
    # Existing event ingress/storage owns the accepted event and revision.
    pending=D/'pending';pending.mkdir(parents=True,exist_ok=True)
    if pending.is_symlink():raise ValueError('memory_source_unavailable')
    file=pending/(identity+'.json')
    payload={'version':2,'id':identity,'surface':'openclaw','kind':'checkpoint','text':text,
             'supersedes':eid,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as stream:json.dump(payload,stream,separators=(',',':'))
    except FileExistsError:pass
    try:
        with connect() as writer:ingest_file(writer,file,require_active=eid)
    except ValueError as error:
        if str(error)!='memory_already_superseded':raise
        file.unlink(missing_ok=True)
    # Reconciliation remains with the existing compactor; no new task or timer.
    # Do not claim deletion or erase immutable history; supersession hides current knowledge.
    with control_read() as c:return forget_probe(c,eid,op)[0]


def control_import(body, check=False):
    plan, items = import_selection(body)
    op = body['operationId']
    identity = hashlib.sha256(('memory-operation\0'+op).encode()).hexdigest()
    binding = {'version':1,'operationId':op,'previewHash':plan['previewHash'],'selectedIds':sorted(body['selectedIds'])}
    text = 'MEMORY_IMPORT_RECEIPT_V1 '+import_canonical(binding)
    def probe(c):
        row=c.execute('SELECT text,revision,created_at FROM events WHERE id=?',(identity,)).fetchone()
        if not row:return None
        if row[0]!=text:return {'success':False,'state':'conflict','receipt':None,'error':'memory_operation_conflict'}
        return {'success':True,'state':'imported','receipt':{'version':1,'action':'memory.import','operationId':op,'eventId':identity,'revision':row[1],'at':row[2]},'importedCount':len(items)}
    with control_read() as reader:
        prior=probe(reader)
    if prior:return prior
    if check:return {'success':False,'state':'not_found','receipt':None}
    # The existing owner writes a single atomic batch to its events/revision tables.
    # No secondary import ledger or preview storage is created.
    with connect() as writer:
        migrate(writer)
        writer.execute('BEGIN IMMEDIATE')
        try:
            prior=probe(writer)
            if prior:
                writer.execute('ROLLBACK')
                return prior
            revision=int(writer.execute("SELECT value FROM memory_meta WHERE key='current_revision'").fetchone()[0])
            now=datetime.datetime.now(datetime.timezone.utc).isoformat()
            archival=[]
            for item in items:
                revision+=1
                event_id=hashlib.sha256(('memory-import\0'+op+'\0'+item['id']).encode()).hexdigest()
                payload='MEMORY_IMPORT_V1 '+import_canonical({k:item[k] for k in ('source','text','originalCreatedAt')})
                writer.execute('INSERT INTO events(id,surface,kind,text,created_at,ingested_at,supersedes,revision) VALUES(?,?,?,?,?,?,?,?)',(event_id,'chat' if plan['source']=='chatgpt' else 'work','learning',payload,now,now,None,revision))
                archival.append({'id':event_id,'surface':'chat' if plan['source']=='chatgpt' else 'work','kind':'learning','text':payload,'createdAt':now,'revision':revision})
            revision+=1
            writer.execute('INSERT INTO events(id,surface,kind,text,created_at,ingested_at,supersedes,revision) VALUES(?,?,?,?,?,?,?,?)',(identity,'openclaw','checkpoint',text,now,now,None,revision))
            archival.append({'id':identity,'surface':'openclaw','kind':'checkpoint','text':text,'createdAt':now,'revision':revision})
            writer.execute("UPDATE memory_meta SET value=? WHERE key='current_revision'",(str(revision),))
            writer.execute('COMMIT')
        except Exception:
            writer.execute('ROLLBACK');raise
        # Same monthly archive as ingest_file. The canonical SQLite receipt already
        # proves the batch if the post-commit append fails; never replay its effects.
        try:
            history=D/'history';history.mkdir(parents=True,exist_ok=True)
            archive=history/(datetime.datetime.now().astimezone().strftime('%Y-%m')+'.jsonl')
            fd=os.open(archive,os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w') as stream:
                for event in archival:stream.write(import_canonical(event)+'\n')
        except OSError:
            # SQLite COMMIT is authoritative; archive repair must not misreport or replay it.
            pass
        return probe(writer)


def import_command(command):
    raw=sys.stdin.buffer.read(1024*1024+1)
    if len(raw)>1024*1024:raise ValueError('memory_export_too_large')
    body=json.loads(raw)
    if command=='control-import-preview':
        if not isinstance(body,dict) or set(body)!={'source','export'}:raise ValueError('invalid_memory_export')
        return import_preview(body['source'],body['export'])
    if command not in {'control-import','control-import-check'}:raise ValueError('invalid_memory_import')
    return control_import(body,check=command=='control-import-check')


def main():
    if len(sys.argv)>1 and sys.argv[1].startswith('control-import'):
        try:print(json.dumps(import_command(sys.argv[1]),ensure_ascii=False,separators=(',',':')))
        except (ValueError,OSError,sqlite3.Error):print(json.dumps({'success':False,'state':'failed','receipt':None,'error':'memory_import_unavailable'}));return 1
        return 0
    if len(sys.argv)>1 and sys.argv[1].startswith('control-'):
        try:print(json.dumps(control_command(sys.argv[1:]),ensure_ascii=False,separators=(',',':')))
        except (ValueError,OSError,sqlite3.Error):print(json.dumps({'error':'memory_source_unavailable'}));return 1
        return 0
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
if __name__=="__main__": raise SystemExit(main())
