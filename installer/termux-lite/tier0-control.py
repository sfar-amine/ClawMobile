#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse,datetime as dt,hashlib,json,os,shutil,tempfile
from pathlib import Path

HOME=Path.home()
TIER0=HOME/'.openclaw/tier0'
RELEASES=HOME/'.openclaw/releases'
STATE=TIER0/'state.json'
STOP=TIER0/'emergency-stop.json'
CURRENT=RELEASES/'current'
LKG=RELEASES/'last-known-good'

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def atomic_json(path,data):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(data,f,indent=2,sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def sha(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def manifest(root):
    rows={}
    for p in sorted(Path(root).rglob('*')):
        if p.is_file() and '.git' not in p.parts and '__pycache__' not in p.parts:
            rows[str(p.relative_to(root))]={'sha256':sha(p),'mode':oct(p.stat().st_mode & 0o777)}
    return rows

def verify_release(path):
    path=Path(path); m=json.loads((path/'manifest.json').read_text())
    for name,meta in m['files'].items():
        p=path/name
        if not p.is_file() or sha(p)!=meta['sha256']:
            raise RuntimeError(f'release_hash_mismatch:{name}')
    return m

def link_atomic(link,target):
    link=Path(link); link.parent.mkdir(parents=True,exist_ok=True)
    tmp=link.with_name(link.name+'.next')
    try: tmp.unlink()
    except FileNotFoundError: pass
    tmp.symlink_to(Path(target))
    os.replace(tmp,link)

def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}

def save_state(s):
    s['updated_at']=now(); atomic_json(STATE,s)

def cmd_package(a):
    source=Path(a.source).resolve()
    if not source.is_dir(): raise SystemExit('source_not_found')
    release_id=a.release_id or dt.datetime.now().strftime('%Y%m%dT%H%M%S')+'-'+hashlib.sha256(str(source).encode()).hexdigest()[:8]
    dest=RELEASES/release_id
    if dest.exists(): raise SystemExit('release_exists')
    tmp=RELEASES/(release_id+'.tmp'); shutil.rmtree(tmp,ignore_errors=True); tmp.mkdir(parents=True)
    shutil.copytree(source,tmp/'termux-lite',dirs_exist_ok=True,symlinks=True)
    meta={'version':1,'release_id':release_id,'created_at':now(),'source':str(source),
          'source_commit':a.source_commit,'soak_seconds':a.soak_seconds,
          'critical_capabilities':a.critical_capability or ['immune.root_guardian','immune.health_manager','immune.incident_orchestrator'],
          'files':manifest(tmp),'product_manifest':None}
    if a.product_manifest:
        pm=Path(a.product_manifest).resolve()
        if not pm.is_file(): raise SystemExit('product_manifest_not_found')
        shutil.copy2(pm,tmp/'product-manifest.json')
        meta['product_manifest']={'sha256':sha(tmp/'product-manifest.json'),'source':str(pm)}
    atomic_json(tmp/'manifest.json',meta); os.replace(tmp,dest)
    verify_release(dest); print(release_id)

def cmd_promote(a):
    target=RELEASES/a.release_id; meta=verify_release(target)
    old=CURRENT.resolve() if CURRENT.exists() else None
    if old and old!=target.resolve(): link_atomic(LKG,old)
    link_atomic(CURRENT,target)
    s=load_state(); s.update({'current':a.release_id,'last_known_good':LKG.resolve().name if LKG.exists() else None,
        'soak_started_at':now(),'soak_deadline_epoch':int(dt.datetime.now().timestamp())+int(meta.get('soak_seconds',300)),
        'soak_bad_samples':0,'soak_state':'running','critical_capabilities':meta.get('critical_capabilities',[])})
    save_state(s); print(json.dumps(s))

def cmd_rollback(a):
    if not LKG.exists(): raise SystemExit('no_last_known_good')
    target=LKG.resolve(); verify_release(target); link_atomic(CURRENT,target)
    s=load_state(); previous=s.get('current'); s.update({'current':target.name,'rolled_back_from':previous,'rollback_reason':a.reason,'soak_state':'rolled_back'})
    save_state(s); print(target.name)

def cmd_stop(a):
    atomic_json(STOP,{'enabled':True,'reason':a.reason,'created_at':now()})
    print('AUTONOMOUS_ENGINEERING_STOPPED')

def cmd_resume(a):
    try: STOP.unlink()
    except FileNotFoundError: pass
    print('AUTONOMOUS_ENGINEERING_ENABLED')

def cmd_status(a):
    s=load_state(); s['emergency_stop']=STOP.exists()
    s['current_path']=str(CURRENT.resolve()) if CURRENT.exists() else None
    s['lkg_path']=str(LKG.resolve()) if LKG.exists() else None
    print(json.dumps(s,indent=2,sort_keys=True))

def cmd_root(a):
    if not CURRENT.exists(): raise SystemExit('no_active_release')
    print(CURRENT.resolve()/'termux-lite')

def main():
    p=argparse.ArgumentParser(); sp=p.add_subparsers(dest='cmd',required=True)
    q=sp.add_parser('package'); q.add_argument('--source',required=True); q.add_argument('--source-commit'); q.add_argument('--release-id'); q.add_argument('--soak-seconds',type=int,default=300); q.add_argument('--critical-capability',action='append'); q.add_argument('--product-manifest')
    q=sp.add_parser('promote'); q.add_argument('release_id')
    q=sp.add_parser('rollback'); q.add_argument('--reason',default='manual')
    q=sp.add_parser('stop'); q.add_argument('--reason',default='manual')
    sp.add_parser('resume'); sp.add_parser('status'); sp.add_parser('root')
    a=p.parse_args(); RELEASES.mkdir(parents=True,exist_ok=True); TIER0.mkdir(parents=True,exist_ok=True)
    return globals()['cmd_'+a.cmd.replace('-','_')](a)
if __name__=='__main__': main()
