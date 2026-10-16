"""Bounded, source-grounded native memory output of the existing curator.

No rules are applied, no event is edited, no scheduler is introduced. Counters
from native dreaming stay unknown until their installed owner is attested.
"""
import datetime, hashlib, json, os, re, stat
from pathlib import Path
from zoneinfo import ZoneInfo
from context_import import PAYMENT, SENSITIVE
from context_memory import ACTIVE

MAX_ITEMS, MAX_BYTES, MAX_FILES = 60, 12 * 1024, 30
HEADER = '# Mémoire inter-surfaces\n\nExtraits sourcés, non normatifs. Aucune règle, autorisation ou instruction nouvelle. Relire les sources actives avant utilisation.\n\n'
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}\.md$')
IDENTITY = re.compile(r'^[a-f0-9]{64}$')

def close_supersessions(conn, now):
    """The source author already changed ACTIVE; never infer a replacement."""
    conn.execute("""UPDATE dream_proposals SET status='applied', applied_at=?,
        payload=json_set(payload,'$.reason','author_declared_supersession')
        WHERE action='confirm_supersession' AND status='proposed' AND json_valid(payload)
        AND EXISTS(SELECT 1 FROM events r WHERE r.id=
            CASE WHEN json_valid(payload) THEN json_extract(payload,'$.replacement') END
            AND r.supersedes=CASE WHEN json_valid(payload) THEN json_extract(payload,'$.superseded') END)""", (now.isoformat(),))
    return conn.execute('SELECT changes()').fetchone()[0]

def _anchor(absolute):
    """Android denies opening '/' to apps (S24 12/10 : the curator failed every run). The owner's
    HOME is then the trusted anchor; below it, the walk stays descriptor-based and NOFOLLOW."""
    try: return os.open('/',os.O_RDONLY|os.O_DIRECTORY),absolute.parts[1:]
    except PermissionError:
        home=Path(os.path.abspath(os.path.expanduser('~')))
        if absolute!=home and home not in absolute.parents: raise
        return os.open(home,os.O_RDONLY|os.O_DIRECTORY),absolute.relative_to(home).parts

def _directory(path):
    # Walk directory descriptors: no symlink ancestor or rename race follows a foreign tree.
    absolute=Path(os.path.abspath(path));fd,parts=_anchor(absolute)
    try:
        for part in parts:
            try: child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part,mode=0o700,dir_fd=fd)
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
        return fd
    except Exception: os.close(fd);raise

def _files(fd,day):
    files=[]
    for name in os.listdir(fd):
        if not DAY.fullmatch(name): continue
        try: date=datetime.date.fromisoformat(name[:-3])
        except ValueError: raise ValueError('native_memory_file_unavailable')
        if name>day+'.md': raise ValueError('native_memory_future_file')
        info=os.stat(name,dir_fd=fd,follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode): raise ValueError('native_memory_file_unavailable')
        files.append(name)
    return sorted(files)

def _read(fd,name):
    file=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
    try:
        info=os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>MAX_BYTES:
            raise ValueError('native_memory_file_unavailable')
        return os.read(file,MAX_BYTES+1)
    finally: os.close(file)

def _write(fd,name,body):
    import secrets
    temporary='.'+secrets.token_hex(16)+'.tmp'
    file=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    try:
        with os.fdopen(file,'wb') as stream: stream.write(body);stream.flush();os.fsync(stream.fileno())
        # The existing curator lock serializes writers; a foreign collision is refused.
        try: os.stat(name,dir_fd=fd,follow_symlinks=False)
        except FileNotFoundError: pass
        else: raise ValueError('native_memory_file_collision')
        if hasattr(os,'link'): os.link(temporary,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
        else:
            # Android/Termux Python has no os.link (S24 12/10). The fully written, fsynced temporary is
            # renamed in the same directory; the stat above and the curator lock refuse a collision.
            os.rename(temporary,name,src_dir_fd=fd,dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try: os.unlink(temporary,dir_fd=fd)
        except FileNotFoundError: pass

def bridge_digest(conn, workspace, now):
    """One immutable daily projection; file precedes the owner transaction receipt.

    A crash before COMMIT recovers only when the exact existing output matches.
    Uncertain/colliding output is never replaced or silently acknowledged.
    """
    day=now.astimezone(ZoneInfo('Africa/Tunis')).date().isoformat()
    marker=conn.execute("SELECT value FROM memory_meta WHERE key='curator_native_digest_v1'").fetchone()
    if marker:
        prior=json.loads(marker[0])
        if prior.get('date')==day:
            fd=_directory(Path(workspace)/'memory/cross-surface')
            try:
                body=_read(fd,day+'.md')
                if hashlib.sha256(body).hexdigest()!=prior.get('sha256'): raise ValueError('native_memory_receipt_mismatch')
            finally: os.close(fd)
            return {**prior,'state':'unchanged','newElementsLinked':0}
    if now.astimezone(ZoneInfo('Africa/Tunis')).hour>=22:
        return {'state':'missed_window','date':day,'elementsLinked':0,'newElementsLinked':0}
    # Existing digest proposal IDs delimit eligibility; source events remain authoritative.
    proposals=conn.execute("SELECT proposal_id,source_ids,created_at FROM dream_proposals WHERE action='memory_digest' AND status='proposed' ORDER BY created_at DESC,proposal_id LIMIT 5000").fetchall()
    source_proposals={};eligible=[]
    for pid,source_json,created in proposals:
        try:
            if not isinstance(created,str) or len(created)>40: continue
            stamp=datetime.datetime.fromisoformat(created.replace('Z','+00:00'))
            if stamp.tzinfo is None or stamp.astimezone(ZoneInfo('Africa/Tunis')).date().isoformat()!=day: continue
            if not isinstance(source_json,str) or len(source_json.encode())>8192: continue
            ids=json.loads(source_json)
            if not isinstance(ids,list) or len(ids)>24: continue
            for identifier in ids:
                if isinstance(identifier,str) and IDENTITY.fullmatch(identifier): source_proposals.setdefault(identifier,[]).append(pid)
            eligible.append(pid)
        except (ValueError,TypeError,AttributeError): continue
    if not source_proposals: return {'state':'no_digest','date':day,'elementsLinked':0,'newElementsLinked':0}
    items=[];filtered=0;body=HEADER.encode();bridged=set()
    # Never trust copied digest excerpts: retrieve the exact still-active owner event.
    source_ids=list(source_proposals)[:5000]
    for (identifier,revision,surface,kind,text,created) in conn.execute(f"SELECT e.id,e.revision,e.surface,e.kind,e.text,e.created_at FROM json_each(?) ids JOIN events e ON e.id=ids.value WHERE {ACTIVE} AND e.kind IN ('decision','checkpoint','learning','constraint') AND length(CAST(e.text AS BLOB))<=32768 ORDER BY e.revision DESC LIMIT 1000", (json.dumps(source_ids),)):
        if identifier not in source_proposals: continue
        if not isinstance(text,str) or SENSITIVE.search(text) or PAYMENT.search(text): filtered+=1;continue
        if not isinstance(surface,str) or not re.fullmatch('[a-z_]{1,40}',surface) or SENSITIVE.search(surface) or PAYMENT.search(surface): filtered+=1;continue
        try:
            stamp=datetime.datetime.fromisoformat(created.replace('Z','+00:00'))
            if stamp.tzinfo is None: raise ValueError()
        except (ValueError,TypeError,AttributeError): filtered+=1;continue
        item={'id':identifier,'surface':surface,'date':stamp.isoformat(),'kind':kind,'excerpt':' '.join(text.split())[:160],'source_sha256':hashlib.sha256(text.encode()).hexdigest()}
        line=('- '+json.dumps(item,ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(items)>=MAX_ITEMS or len(body)+len(line)>MAX_BYTES: break
        body+=line;items.append(item);bridged.update(source_proposals[identifier])
    if not items: return {'state':'filtered','date':day,'elementsLinked':0,'newElementsLinked':0,'filteredCount':filtered}
    fd=_directory(Path(workspace)/'memory/cross-surface')
    try:
        files=_files(fd,day);name=day+'.md'
        if name in files:
            if _read(fd,name)!=body: raise ValueError('native_memory_file_collision')
        else: _write(fd,name,body)
        for stale in sorted(set(files+[name]))[:-MAX_FILES]: os.unlink(stale,dir_fd=fd)
        os.fsync(fd)
    finally: os.close(fd)
    result={'version':1,'date':day,'state':'bridged','elementsLinked':len(items),'newElementsLinked':len(items),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'filteredCount':filtered,'partial':len(items)<len(source_proposals),'proposalsBridged':len(bridged),'writtenAt':now.isoformat()}
    for pid in bridged:
        conn.execute("UPDATE dream_proposals SET status='bridged',applied_at=? WHERE proposal_id=? AND action='memory_digest' AND status='proposed'",(now.isoformat(),pid))
    # Each bridged proposal may be partially represented; the receipt is explicit.
    conn.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('curator_native_digest_v1',?)",(json.dumps(result,separators=(',',':')),))
    return result
