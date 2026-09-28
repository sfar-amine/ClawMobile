#!/data/data/com.termux/files/usr/bin/python3
import argparse,json,os,sqlite3,subprocess,time
from pathlib import Path
H=Path.home(); OC=H/'.openclaw'; ROOT=H/'ClawMobile/installer/termux-lite'; OUT=OC/'health/current.json'
NOW=time.time()
def run(cmd,timeout=5):
 try:return subprocess.run(cmd,shell=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout).stdout.strip()
 except Exception:return ''
def proc(p):return bool(run(f"pgrep -f '{p}'"))
def age(p):
 try:return max(0,NOW-p.stat().st_mtime)
 except:return None
def item(state,critical=True,reason='',evidence='',freshness=None):
 return {'state':state,'critical':critical,'reason':reason or None,'evidence':evidence or None,'freshness_s':round(freshness,1) if freshness is not None else None,'checked_at':int(NOW)}
def whatsapp_health(raw,last_outbound=''):
 lines=[z.strip().lower() for z in raw.splitlines()]
 status=next((z for z in lines if z.startswith('- whatsapp ')), '')
 terminal=('health:logged-out' in status or 'status=401 unauthorized' in status or 'session logged out' in raw.lower())
 failed='state=failed' in last_outbound.lower()
 connected=', connected' in status and 'stopped' not in status
 if terminal:return 'down','terminal_auth_logout'
 if connected and failed:return 'degraded','latest_outbound_failed'
 if connected:return 'healthy','channel_connected'
 return 'down','channel_not_connected'
def latest_channel_event(path,channel):
 if not path.exists():return ''
 rows=[z for z in path.read_text(errors='ignore').splitlines() if f'channel={channel} state=' in z]
 return rows[-1] if rows else ''
def smtp_health(probe_path,events_path):
 try:
  probe=json.loads(probe_path.read_text()); fresh=NOW-float(probe.get('checked_at',0))
  if fresh<=900 and probe.get('state') in ('ready','down'):
   return probe['state'],probe.get('reason') or 'live_probe',fresh
 except (OSError,ValueError,TypeError):
  pass
 last=latest_channel_event(events_path,'email')
 if 'state=accepted' in last:return 'ready','latest_delivery_accepted',None
 if 'state=failed' in last:return 'down','latest_delivery_failed',None
 return 'unverified','no_delivery_or_probe_evidence',None
def live():
 x={}
 expected=(OC/'watchdogs/adb-expected-serial').read_text().strip() if (OC/'watchdogs/adb-expected-serial').exists() else ''
 state=run('timeout 3 adb -s 127.0.0.1:5556 get-state')
 serial=run('timeout 3 adb -s 127.0.0.1:5556 shell getprop ro.serialno')
 x['device.adb']=item('healthy' if state=='device' and (not expected or serial==expected) else 'degraded',True,'canonical endpoint verified' if state=='device' else 'canonical endpoint unavailable','127.0.0.1:5556')
 checks={
  'immune.root_guardian':("[s]amantha-root-guardian.sh",OC/'health/root-guardian.heartbeat',30),
  'immune.health_manager':("[s]amantha-health-manager.sh",OC/'health/health-manager.heartbeat',45),
  'immune.incident_manager':("[i]ncident-manager.sh",OC/'health/incident-manager.heartbeat',30),
  'immune.incident_orchestrator':("[i]ncident-orchestrator-worker.sh",OC/'health/incident-orchestrator.heartbeat',20),
  'immune.remote_watchdog':("[r]emote-desktop-watchdog.sh",OC/'health/remote-watchdog.heartbeat',45),
  'immune.adb_watchdog':("[a]db-recovery-watchdog.sh",OC/'health/adb-watchdog.heartbeat',150),
 }
 for k,(pat,log,ttl) in checks.items():
  a=age(log); up=proc(pat)
  st='healthy' if up and a is not None and a<=ttl else ('stale' if up else 'down')
  x[k]=item(st,True,'process and loop evidence healthy' if st=='healthy' else ('loop evidence stale' if up else 'process missing'),str(log),a)
 x['remote_desktop']=item('healthy' if proc('@wonderwhy-er/desktop-commander/dist/index.js remote') else 'down',True,evidence='desktop-commander remote')
 x['gateway']=item('healthy' if run('curl -fsS --max-time 3 http://127.0.0.1:18789/healthz') else 'down',True,evidence='http://127.0.0.1:18789/healthz')
 x['companion']=item('healthy' if run('curl -fsS --max-time 3 http://127.0.0.1:8765/v1/health') else 'down',True,evidence='http://127.0.0.1:8765/v1/health')
 wa=run('timeout 8 openclaw channels status',10); ev=OC/'incidents/events.log'
 outbound=OC/'health/whatsapp-outbound.log'; lastwa=''
 if outbound.exists():
  lines=[z for z in outbound.read_text(errors='ignore').splitlines() if 'state=' in z]
  if lines:lastwa=lines[-1]
 if not lastwa:lastwa=latest_channel_event(ev,'whatsapp')
 wastate,wareason=whatsapp_health(wa,lastwa)
 x['notification.whatsapp']=item(wastate,False,reason=wareason,evidence='channel status + latest canonical outbound evidence')
 smstate,smreason,smfresh=smtp_health(OC/'health/smtp-probe.json',ev)
 x['notification.smtp']=item(smstate,False,reason=smreason,evidence='live SMTP probe + latest delivery evidence',freshness=smfresh)
 tx=OC/'health/transaction-health.json'
 try:
  td=json.loads(tx.read_text()); ta=NOW-float(td.get('checked_at',0)); ts=td.get('status','unverified')
  x['transactions.runtime']=item(ts if ta<=660 else 'stale',True,reason=f"pending_archives={td.get('pending_archives',0)} repeated_failures={sum(1 for r in td.get('failures',{}).values() if int(r.get('count',0))>=2)}",evidence=str(tx),freshness=ta)
 except (OSError,ValueError,TypeError):
  x['transactions.runtime']=item('unverified',True,reason='transaction health receipt absent or invalid',evidence=str(tx))
 x['boot.persistence']=item('ready' if (H/'.termux/boot/start-samantha').exists() else 'down',True,evidence='Termux:Boot')
 x['chat.continuity']=item('ready' if (OC/'continuity/chatgpt-current.json').stat().st_size>0 else 'degraded',False,evidence='chat checkpoint') if (OC/'continuity/chatgpt-current.json').exists() else item('degraded',False,reason='checkpoint absent')
 return x
def incidents():
 p=OC/'incidents/orchestrator.db'; active=[]; recent_failed=[]; human=[]
 if not p.exists():return active,recent_failed,human
 c=sqlite3.connect(p);c.row_factory=sqlite3.Row
 for r in c.execute("select * from incidents order by updated desc"):
  d=dict(r)
  if d['state'] not in ('recovered','failed'):active.append(d)
  if d['state']=='failed' and NOW-d['updated']<86400:recent_failed.append(d)
  if d['state']=='human_required':human.append(d)
 c.close();return active,recent_failed,human
def continuations():
 blocked=resuming=stuck=0; details=[]
 p=OC/'continuations/retrieval-runs.json'
 if p.exists():
  try: rows=json.loads(p.read_text())
  except: rows={}
  for rid,r in rows.items():
   st=r.get('state');blocked+=st=='blocked';resuming+=st=='resuming'
   if st in ('blocked','resuming') and NOW-float(r.get('updated_at',NOW))>300:
    stuck+=1;details.append({'run_id':rid,'state':st})
 return {'blocked':blocked,'resuming':resuming,'stuck':stuck,'details':details}
def build():
 caps=live(); active,failed,human=incidents(); cont=continuations(); warnings=[]
 live_components={k.split('.',1)[-1]:v for k,v in caps.items()}
 for i in active:
  ck=i['component']
  if ck in live_components and live_components[ck]['state'] in ('healthy','ready'):warnings.append({'type':'incident_live_mismatch','incident_id':i['id'],'component':ck})
 if cont['stuck']:warnings.append({'type':'continuation_gap','count':cont['stuck']})
 crit_bad=[k for k,v in caps.items() if v['critical'] and v['state'] not in ('healthy','ready')]
 noncrit_bad=[k for k,v in caps.items() if not v['critical'] and v['state'] not in ('healthy','ready')]
 overall='down' if any(caps[k]['state']=='down' for k in crit_bad) else ('degraded' if crit_bad or noncrit_bad or active or cont['stuck'] else 'healthy')
 return {'schema_version':1,'generated_at':int(NOW),'overall':overall,'summary':{'healthy_ready':sum(v['state'] in ('healthy','ready') for v in caps.values()),'degraded_stale_unverified':sum(v['state'] in ('degraded','stale','unverified') for v in caps.values()),'down':sum(v['state']=='down' for v in caps.values()),'active_incidents':len(active),'human_required':len(human),'stuck_continuations':cont['stuck']},'capabilities':caps,'incidents':{'active':active,'recent_failed':failed[:10],'human_required':human},'continuations':cont,'consistency_warnings':warnings}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--json',action='store_true');ap.add_argument('--write',action='store_true');a=ap.parse_args();v=build()
 if a.write:
  OUT.parent.mkdir(parents=True,exist_ok=True);tmp=OUT.with_suffix('.tmp');tmp.write_text(json.dumps(v,indent=2,sort_keys=True)+'\n');os.replace(tmp,OUT)
 if a.json:print(json.dumps(v,indent=2,sort_keys=True))
 else:
  s=v['summary'];print(f"IMMUNE SYSTEM: {v['overall'].upper()}");print(f"{s['healthy_ready']} healthy/ready | {s['degraded_stale_unverified']} degraded/stale | {s['down']} down | {s['active_incidents']} active incidents | {s['stuck_continuations']} stuck continuations")
  for k,x in v['capabilities'].items():print(f"{k:30} {x['state'].upper()}")
if __name__=='__main__':main()
