#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import fcntl,json,os,subprocess,time
from pathlib import Path
H=Path.home(); T=H/'.openclaw/tier0'; STATE=T/'state.json'; STOP=T/'emergency-stop.json'; HEALTH=H/'.openclaw/health/current.json'
CONTROL=T/'bin/tier0-control.py'; BOOT=T/'bin/tier0-bootstrap.sh'
OK={'healthy','ready'}
# Doc 51 I3: a release that passed the soak becomes last-known-good only after this many clean seconds.
LKG_HOLD_S=int(os.environ.get('TIER0_LKG_HOLD_S','21600'))
DEPLOY_LOCK=H/'.openclaw/deploys/companion-deploy.lock'
def deploying():
    """A Companion deploy restarts the Companion on purpose: its samples are not evidence against the release."""
    if not DEPLOY_LOCK.exists(): return False
    try:
        with DEPLOY_LOCK.open('a') as f:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(f,fcntl.LOCK_UN)
        return False
    except OSError: return True
def bad_caps(s,health=None):
    caps=(load(HEALTH) if health is None else health).get('capabilities',{})
    return [c for c in s.get('critical_capabilities',[]) if str(caps.get(c,{}).get('state','')).lower() not in OK]
def hold(s):
    """Stable release waiting to become LKG: any bad sample restarts the clean window; a newer promotion drops it."""
    cand=s.get('lkg_candidate')
    cur=(H/'.openclaw/releases/current').resolve()
    if cur.name!=cand:
        s.pop('lkg_candidate',None);s.pop('lkg_due_epoch',None);save(s);return
    if deploying(): return
    if bad_caps(s):
        s['lkg_due_epoch']=int(time.time())+LKG_HOLD_S;save(s);return
    if int(time.time())>=int(s.get('lkg_due_epoch',0)):
        lkg=H/'.openclaw/releases/last-known-good';tmp=lkg.with_name('last-known-good.next')
        try:tmp.unlink()
        except FileNotFoundError:pass
        tmp.symlink_to(cur);tmp.replace(lkg)
        s['last_known_good']=cur.name;s.pop('lkg_candidate',None);s.pop('lkg_due_epoch',None);s['lkg_confirmed_at']=time.time();save(s)
def load(p):
    try:return json.loads(p.read_text())
    except Exception:return {}
def save(s):
    s['updated_at']=time.time()
    tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(s,indent=2,sort_keys=True)+'\n');tmp.replace(STATE)
def tick():
    s=load(STATE)
    if s and s.get('soak_state')=='stable' and s.get('lkg_candidate'): return hold(s)
    if not s or s.get('soak_state')!='running': return
    if deploying():
        s['soak_bad_samples']=0;save(s);return
    if int(time.time()) < int(s.get('soak_grace_until_epoch',0)):
        s['soak_bad_samples']=0;save(s);return
    health=load(HEALTH);generated=health.get('generated_at')
    if isinstance(generated,(int,float)) and not isinstance(generated,bool) and generated<int(s.get('soak_grace_until_epoch',0)):
        # A health sample generated before the end of the startup grace describes the restart (Gateway restart by
        # runtime-sync, 16/10: rollback on such a sample), not the release: wait for a fresh one, count nothing.
        return
    bad=bad_caps(s,health)
    if bad:s['soak_bad_samples']=int(s.get('soak_bad_samples',0))+1;s['last_bad']=bad
    else:s['soak_bad_samples']=0;s.pop('last_bad',None)
    if s.get('soak_bad_samples',0)>=2 and not STOP.exists():
        lkg=H/'.openclaw/releases/last-known-good'
        if not lkg.exists():
            STOP.parent.mkdir(parents=True,exist_ok=True)
            STOP.write_text(json.dumps({'enabled':True,'reason':'soak_health_regression_without_lkg','created_at':time.time()},sort_keys=True)+'\n')
            s['soak_state']='failed_no_lkg';save(s);return
        subprocess.run([str(CONTROL),'rollback','--reason','soak_health_regression'],check=True)
        subprocess.Popen([str(BOOT),'--restart-core'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return
    if int(time.time())>=int(s.get('soak_deadline_epoch',0)) and not bad:
        # The previous LKG stays the rollback target until this release has held LKG_HOLD_S clean seconds.
        cur=(H/'.openclaw/releases/current').resolve()
        s['soak_state']='stable';s['soak_completed_at']=time.time()
        s['lkg_candidate']=cur.name;s['lkg_due_epoch']=int(time.time())+LKG_HOLD_S
    save(s)
def main():
    while True:
        try:tick()
        except Exception as e:
            with (T/'watchdog.log').open('a') as f:f.write(f'{time.time()} error={type(e).__name__}\n')
        time.sleep(10)
if __name__=='__main__':main()
