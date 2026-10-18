#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import fcntl,json,os,subprocess,time,math,runpy
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
def sample_evidence(s,health,decision):
    # Bounded, content-free projection. Never log probe bodies, reasons or URLs.
    caps=health.get('capabilities',{})
    states={}
    allowed={'healthy','ready','down','degraded','stale','unverified','blocked','starting'}
    for cap in s.get('critical_capabilities',[])[:32]:
        if not isinstance(cap,str) or len(cap)>80: continue
        state=caps.get(cap,{}).get('state') if isinstance(caps.get(cap),dict) else None
        states[cap]=state if state in allowed else 'unknown'
    return {'source':'health/current.json','producer':'health-verdict.py','generated_at':health.get('generated_at'),
            'observed_at':time.time(),'decision':decision,'states':states}

def rollback_for_sample(s,reason):
    if STOP.exists(): return
    evidence=s.get('soak_last_health_sample',{})
    record={'event':'soak_rollback','reason':reason,**evidence}
    try:
        logger=runpy.run_path(str(Path(__file__).with_name('bounded-log.py')))
        logger['append_line'](T/'watchdog.log',json.dumps(record,sort_keys=True),max_bytes=256*1024,keep=2)
    except (OSError,ValueError):
        s['soak_sample_log_unavailable']=True
    save(s)  # Preserve the actual second sample before the rollback owner reads state.
    lkg=H/'.openclaw/releases/last-known-good'
    if not lkg.exists():
        STOP.parent.mkdir(parents=True,exist_ok=True)
        STOP.write_text(json.dumps({'enabled':True,'reason':reason+'_without_lkg','created_at':time.time()},sort_keys=True)+'\n')
        s['soak_state']='failed_no_lkg';save(s);return
    subprocess.run([str(CONTROL),'rollback','--reason',reason],check=True)
    subprocess.Popen([str(BOOT),'--restart-core'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

def tick():
    s=load(STATE)
    if s and s.get('soak_state')=='stable' and s.get('lkg_candidate'): return hold(s)
    if not s or s.get('soak_state')!='running': return
    if deploying():
        s['soak_bad_samples']=0;save(s);return
    if int(time.time()) < int(s.get('soak_grace_until_epoch',0)):
        s['soak_bad_samples']=0;save(s);return
    health=load(HEALTH)
    if not isinstance(health,dict): health={}
    generated=health.get('generated_at');now=time.time()
    deadline=int(s.get('soak_deadline_epoch',0))
    invalid_time=type(generated) not in (int,float) or not math.isfinite(generated) or generated>now
    if invalid_time or not isinstance(health.get('capabilities'),dict):
        safe={} if invalid_time else {'generated_at':generated}
        s['soak_last_health_sample']=sample_evidence(s,safe,'invalid_health_timestamp' if invalid_time else 'invalid_capability_schema')
        if now>=deadline: return rollback_for_sample(s,'soak_health_evidence_unavailable')
        save(s);return
    if generated<int(s.get('soak_grace_until_epoch',0)):
        # Restart evidence cannot condemn the release. No polling tick is a new sample.
        return
    previous=s.get('soak_last_health_generated_at')
    if type(previous) not in (int,float) or not math.isfinite(previous):
        previous=None;s['soak_bad_samples']=0
    if previous is not None and generated<previous:
        s['soak_last_health_sample']=sample_evidence(s,health,'out_of_order_health_sample')
        if now>=deadline: return rollback_for_sample(s,'soak_health_evidence_unavailable')
        save(s);return
    bad=bad_caps(s,health)
    if previous==generated and bad:
        if now>=deadline:
            s['soak_last_health_sample']=sample_evidence(s,health,'health_sample_not_refreshed')
            return rollback_for_sample(s,'soak_health_evidence_unavailable')
        return
    if previous!=generated:
        s['soak_last_health_generated_at']=generated
        if bad:s['soak_bad_samples']=int(s.get('soak_bad_samples',0))+1;s['last_bad']=bad
        else:s['soak_bad_samples']=0;s.pop('last_bad',None)
        s['soak_last_health_sample']=sample_evidence(s,health,'counted_bad' if bad else 'counted_healthy')
    if s.get('soak_bad_samples',0)>=2 and not STOP.exists():
        return rollback_for_sample(s,'soak_health_regression')
    if int(now)>=deadline and not bad:
        cur=(H/'.openclaw/releases/current').resolve()
        s['soak_state']='stable';s['soak_completed_at']=now
        s['lkg_candidate']=cur.name;s['lkg_due_epoch']=int(now)+LKG_HOLD_S
    save(s)
def main():
    while True:
        try:tick()
        except Exception as e:
            with (T/'watchdog.log').open('a') as f:f.write(f'{time.time()} error={type(e).__name__}\n')
        time.sleep(10)
if __name__=='__main__':main()
