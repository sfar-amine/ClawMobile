#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse, fcntl, json, os, subprocess, time
from pathlib import Path

HOME=Path.home(); OC=HOME/'.openclaw'; TIER0=OC/'tier0'; BIN=TIER0/'bin'; HEALTH=OC/'health'
RECEIPT=HEALTH/'native-recovery-last.json'; LOCK=TIER0/'native-recovery.lock'
READY={'healthy','ready','e2e_validated','operational','implemented','validated','stable'}

def _json(path:Path, default):
    try:return json.loads(path.read_text())
    except (OSError,ValueError,TypeError):return default

def _run(argv,timeout=8):
    try:return subprocess.run([str(x) for x in argv],text=True,capture_output=True,timeout=timeout)
    except (OSError,subprocess.TimeoutExpired) as exc:
        class Result: returncode=124; stdout=''; stderr=type(exc).__name__
        return Result()

def _write(value:dict):
    HEALTH.mkdir(parents=True,exist_ok=True)
    payload={'version':1,'checked_at':time.time(),**value}
    tmp=RECEIPT.with_suffix('.tmp');tmp.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n');os.chmod(tmp,0o600);os.replace(tmp,RECEIPT)
    return payload

def emergency_stop():return (TIER0/'emergency-stop.json').exists()

def runtime_root():
    control=BIN/'tier0-control.py'
    p=_run([control,'root'],4) if control.exists() else None
    root=Path((p.stdout or '').strip()) if p and p.returncode==0 and (p.stdout or '').strip() else Path(__file__).resolve().parent
    return root

def network_reconcile(root:Path):
    adb=_run(['adb','-s','127.0.0.1:5556','get-state'],3)
    if adb.returncode or adb.stdout.strip()!='device':return {'state':'skipped','reason':'adb_unavailable'}
    guard=root/'android-network-mutation-guard.py'
    p=_run([guard,'ensure-termux-background'],15)
    try: result=json.loads(p.stdout) if p.stdout.strip() else {}
    except ValueError: result={}
    return {'state':'healthy' if p.returncode==0 else 'degraded','result':result,'stderr':(p.stderr or '')[:240]}

def start_tier0():
    bootstrap=BIN/'tier0-bootstrap.sh'
    if not bootstrap.exists():return {'state':'failed','reason':'tier0_bootstrap_missing'}
    try:
        subprocess.Popen([str(bootstrap)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        return {'state':'started'}
    except OSError as exc:return {'state':'failed','reason':type(exc).__name__}

def snapshot(root:Path,refresh=True):
    if refresh and (root/'health-verdict.py').exists():_run([root/'health-verdict.py','--write'],8)
    tier=_json(TIER0/'state.json',{})
    caps=_json(HEALTH/'current.json',{}).get('capabilities',{})
    critical=[str(x) for x in tier.get('critical_capabilities',[]) if str(x)]
    bad={c:(caps.get(c) or {}).get('state','unverified') for c in critical if (caps.get(c) or {}).get('state') not in READY}
    bridge=root/'claw-slack-bridge-health.py'; bridge_rc=_run([bridge],5).returncode if bridge.exists() else 127
    return {'critical_capabilities':critical,'bad_critical':bad,'slack_bridge':'healthy' if bridge_rc==0 else ('delivery_attention' if bridge_rc==3 else 'degraded'),'emergency_stop':emergency_stop(),'runtime_root':str(root)}

def health():
    snap=snapshot(runtime_root())
    state='healthy' if not snap['bad_critical'] and snap['slack_bridge'] in {'healthy','delivery_attention'} else 'degraded'
    return _write({'state':state,'action':'health','snapshot':snap})

def repair(wait_s=30):
    LOCK.parent.mkdir(parents=True,exist_ok=True)
    with LOCK.open('a+') as fd:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return _write({'state':'already_running','action':'repair'})
        if emergency_stop():return _write({'state':'deferred','action':'repair','reason':'tier0_emergency_stop'})
        root=runtime_root(); snap=snapshot(root)
        if not snap['bad_critical'] and snap['slack_bridge'] in {'healthy','delivery_attention'}:
            return _write({'state':'healthy','action':'repair','mutation':'none_already_healthy','snapshot':snap})
        network=network_reconcile(root); boot=start_tier0(); deadline=time.monotonic()+max(2,min(int(wait_s),45))
        while time.monotonic()<deadline:
            root=runtime_root();snap=snapshot(root)
            if not snap['bad_critical'] and snap['slack_bridge'] in {'healthy','delivery_attention'}:
                return _write({'state':'healthy','action':'repair','network':network,'boot':boot,'snapshot':snap})
            time.sleep(2)
        return _write({'state':'recovering','action':'repair','network':network,'boot':boot,'snapshot':snap})

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=('health','repair'));p.add_argument('--wait-s',type=int,default=30);a=p.parse_args()
    out=health() if a.action=='health' else repair(a.wait_s)
    print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
    return 0 if out.get('state') in {'healthy','recovering','deferred','already_running'} else 1
if __name__=='__main__':raise SystemExit(main())
