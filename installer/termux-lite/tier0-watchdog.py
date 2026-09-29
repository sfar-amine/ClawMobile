#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import json,subprocess,time
from pathlib import Path
H=Path.home(); T=H/'.openclaw/tier0'; STATE=T/'state.json'; STOP=T/'emergency-stop.json'; HEALTH=H/'.openclaw/health/current.json'
CONTROL=T/'bin/tier0-control.py'; BOOT=T/'bin/tier0-bootstrap.sh'
OK={'healthy','ready'}
def load(p):
    try:return json.loads(p.read_text())
    except Exception:return {}
def save(s):
    tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(s,indent=2,sort_keys=True)+'\n');tmp.replace(STATE)
def tick():
    s=load(STATE)
    if not s or s.get('soak_state')!='running': return
    h=load(HEALTH); caps=h.get('capabilities',{})
    bad=[c for c in s.get('critical_capabilities',[]) if str(caps.get(c,{}).get('state','')).lower() not in OK]
    if bad:s['soak_bad_samples']=int(s.get('soak_bad_samples',0))+1;s['last_bad']=bad
    else:s['soak_bad_samples']=0;s.pop('last_bad',None)
    if s.get('soak_bad_samples',0)>=2 and not STOP.exists():
        subprocess.run([str(CONTROL),'rollback','--reason','soak_health_regression'],check=True)
        subprocess.Popen([str(BOOT),'--restart-core'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return
    if int(time.time())>=int(s.get('soak_deadline_epoch',0)) and not bad:
        cur=(H/'.openclaw/releases/current').resolve(); lkg=H/'.openclaw/releases/last-known-good'
        tmp=lkg.with_name('last-known-good.next')
        try:tmp.unlink()
        except FileNotFoundError:pass
        tmp.symlink_to(cur);tmp.replace(lkg)
        s['last_known_good']=cur.name;s['soak_state']='stable';s['soak_completed_at']=time.time()
    save(s)
def main():
    while True:
        try:tick()
        except Exception as e:
            with (T/'watchdog.log').open('a') as f:f.write(f'{time.time()} error={type(e).__name__}\n')
        time.sleep(10)
if __name__=='__main__':main()
