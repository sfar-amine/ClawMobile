#!/usr/bin/env python3
"""Nightly read/refusal-only acceptance under the existing deployment lock.

No checkout change, restart, scheduler or authorized request. Claude installs the
job in the existing scheduler; receipts extend ~/.openclaw/deploys only.
"""
import importlib.util
import argparse,datetime as dt,fcntl,heapq,json,math,os,re,selectors,signal,statistics,subprocess,sys,tempfile,time,stat
from pathlib import Path

NIGHTLY=re.compile(r'nightly-[0-9]{8}\.json\Z')
MAX_RECEIPT_BYTES=2*1024*1024
MAX_CHECKS=200
KEEP=30
ACCEPT_TIMEOUT_SECONDS=900

def secret_hook():
 spec=importlib.util.spec_from_file_location('nightly_secret_hook',Path(__file__).with_name('nightly-secret-scan.py'))
 hook=importlib.util.module_from_spec(spec);spec.loader.exec_module(hook)
 return hook

def number(value):
 return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>=0

def read_receipt(path):
 try:
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  with os.fdopen(fd,'r') as f:
   metadata=os.fstat(f.fileno())
   if not stat.S_ISREG(metadata.st_mode) or metadata.st_size>MAX_RECEIPT_BYTES:return None
   row=json.load(f)
  return row if isinstance(row,dict) else None
 except (OSError,ValueError):return None

def nightly_files(state):
 with os.scandir(state) as entries:
  for entry in entries:
   if NIGHTLY.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):yield Path(entry.path)

def closed_acceptance(raw):
 if not isinstance(raw,dict) or not isinstance(raw.get('accepted'),bool) or not isinstance(raw.get('checks'),list) or len(raw['checks'])>MAX_CHECKS:
  raise ValueError('invalid_acceptance_receipt')
 checks=[]
 for c in raw['checks']:
  if not isinstance(c,dict):raise ValueError('invalid_acceptance_check')
  route=c.get('route')
  if not isinstance(route,str) or not re.fullmatch(r'[A-Za-z0-9_{}?=:/ .()&-]{1,240}',route):raise ValueError('invalid_acceptance_route')
  if c.get('status') not in ('ok','fail','skipped') or not number(c.get('seconds')) or not number(c.get('budget')) or c['budget']==0:raise ValueError('invalid_acceptance_check')
  out={k:c[k] for k in ('route','status','seconds','budget')}
  if isinstance(c.get('code'),int) and not isinstance(c['code'],bool) and 0<=c['code']<=599:out['code']=c['code']
  for key in ('leak','settled'):
   if isinstance(c.get(key),bool):out[key]=c[key]
  if c.get('read') in ('cold','warm'):out['read']=c['read']
  checks.append(out)
 return {'accepted':raw['accepted'],'checks':checks}

def route_key(row):return row['route'],row.get('read'),row['budget']

def drift(acceptance,previous):
 history={}
 for receipt in previous[:7]:
  try:old=closed_acceptance(receipt.get('acceptance'))
  except (AttributeError,ValueError):continue
  # A failed/skipped/leaking read is not a successful latency baseline.
  seen=set()
  for row in old['checks']:
   key=route_key(row)
   if key in seen or row['status']!='ok' or row.get('leak') is True:continue
   seen.add(key);history.setdefault(key,[]).append(row['seconds'])
 observations=[]
 for row in acceptance['checks']:
  if row['status']=='skipped':continue
  samples=history.get(route_key(row),[]);median=statistics.median(samples) if samples else None
  reasons=[]
  if row['seconds']>0.8*row['budget']:reasons.append('budget_over_80_percent')
  if median is not None and row['seconds']>1.5*median:reasons.append('over_1_5_median')
  if row['status']=='fail':reasons.append('acceptance_failed')
  observations.append({'route':row['route'],'read':row.get('read'),'seconds':row['seconds'],'budget':row['budget'],'median7':median,'baselineNights':len(samples),'state':'attention' if reasons else 'ok','reasons':reasons})
 return observations

def atomic_receipt(path,row):
 payload=(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n').encode()
 if len(payload)>MAX_RECEIPT_BYTES:raise ValueError('nightly_receipt_too_large')
 if path.is_symlink():raise OSError('nightly_receipt_symlink')
 fd,name=tempfile.mkstemp(prefix='.nightly-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(payload);f.flush();os.fsync(f.fileno())
  os.chmod(name,0o600);os.replace(name,path)
 finally:
  try:os.unlink(name)
  except FileNotFoundError:pass

def retain(state):
 # Only nightly receipts, never deployment receipts, locks, logs or symlinks.
 keep={p.name for p in heapq.nlargest(KEEP,nightly_files(state),key=lambda p:p.name)}
 for path in nightly_files(state):
  if path.name not in keep:
   try:path.unlink()
   except FileNotFoundError:pass

def stop_command_group(child):
 # A successful parent can leave descendants with stdout closed. Terminate the
 # isolated group on every exit, before the caller releases its deployment lock.
 try:os.killpg(child.pid,signal.SIGKILL)
 except ProcessLookupError:pass
 child.wait(timeout=2)
 deadline=time.monotonic()+2
 while True:
  live=False
  for entry in Path('/proc').iterdir():
   if not entry.name.isdigit():continue
   try:
    fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
    if int(fields[2])==child.pid and fields[0] not in ('Z','X'):live=True;break
   except (OSError,ValueError,IndexError):continue
  if not live:return
  if time.monotonic()>=deadline:raise TimeoutError('acceptance_cleanup_timeout')
  time.sleep(0.01)

def bounded_command(command,timeout,max_bytes=MAX_RECEIPT_BYTES):
 child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
 data=bytearray();deadline=time.monotonic()+timeout;selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
 try:
  while selector.get_map():
   remaining=deadline-time.monotonic()
   if remaining<=0:raise TimeoutError('acceptance_timeout')
   for key,_ in selector.select(min(remaining,0.5)):
    chunk=os.read(key.fileobj.fileno(),8192)
    if not chunk:selector.unregister(key.fileobj);continue
    if len(data)+len(chunk)>max_bytes:raise ValueError('acceptance_output_too_large')
    data.extend(chunk)
  code=child.wait(timeout=max(0.001,deadline-time.monotonic()))
  value=json.loads(data);return code,value
 finally:
  selector.close();child.stdout.close()
  stop_command_group(child)

def deployment_preflight():
 # Same installed deployment preflight, observed on S24 before this code:
 # no Gradle/TypeScript heavy job, >=1200 MiB available, one-minute load <=7.
 try:
  heavy=subprocess.run(['pgrep','-f','GradleDaemon|gradle-termux|tsc -p tsconfig'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=2).returncode
  if heavy!=1:return False
  memory=Path('/proc/meminfo').read_text()
  available=re.search(r'^MemAvailable:\s+(\d+) kB$',memory,re.M)
  if not available or int(available[1])//1024<1200:return False
  uptime=subprocess.run(['uptime'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=2)
  load=re.search(r'load average:\s*([0-9.]+)',uptime.stdout)
  return uptime.returncode==0 and (not load or float(load[1])<=7)
 except (OSError,ValueError,subprocess.SubprocessError):return False

def execute(state,root,now=None,runner=bounded_command,notifier=None,preflight=deployment_preflight,secret_roots=None):
 now=now or dt.datetime.now(dt.timezone.utc)
 if now.tzinfo is None:raise ValueError('timezone_required')
 now=now.astimezone(dt.timezone.utc);stamp=now.isoformat();day=now.strftime('%Y%m%d');path=state/('nightly-'+day+'.json')
 state.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd=os.open(state/'companion-deploy.lock',os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
 with os.fdopen(fd,'w') as lock:
  if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):return {'state':'refused','reason':'deployment_lock_invalid'},3
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return {'state':'refused','reason':'deployment_lock_busy'},3
  if not preflight():return {'state':'refused','reason':'deployment_preflight_busy'},3
  previous_today=read_receipt(path)
  if previous_today and previous_today.get('state') in ('ok','attention','failed'):
   return {'state':'already_checked','receipt':path.name},0
  history=[]
  for prior in heapq.nlargest(7,(p for p in nightly_files(state) if p.name<path.name),key=lambda p:p.name):
   row=read_receipt(prior)
   if row:history.append(row)
  receipt={'version':1,'kind':'nightly_acceptance','state':'running','at':stamp,'acceptance':None,'drift':[], 'notificationAttemptedAt':(previous_today or {}).get('notificationAttemptedAt'), 'secretScan':{'state':'not_configured'}}
  atomic_receipt(path,receipt)
  try:
   # Always the acceptance carried by this checkout, no installed stale copy.
   code,raw=runner([sys.executable,str(root/'companion-acceptance.py')],ACCEPT_TIMEOUT_SECONDS)
   acceptance=closed_acceptance(raw);receipt['acceptance']=acceptance;receipt['drift']=drift(acceptance,history)
   receipt['state']='failed' if code!=0 or not acceptance['accepted'] else ('attention' if any(r['state']=='attention' for r in receipt['drift']) else 'ok')
  except (OSError,ValueError,TimeoutError,subprocess.SubprocessError):receipt['state']='failed';receipt['reason']='acceptance_unavailable'
  scan,scan_attention=secret_hook().execute_scan(root,secret_roots or [],history,runner)
  receipt['secretScan']=scan
  if scan_attention and receipt['state']=='ok':receipt['state']='attention'
  if receipt['state']!='ok' and not receipt['notificationAttemptedAt']:
   # Persist before calling the canonical incident owner: never resend after an
   # uncertain notification/crash. No message content or new notification store.
   receipt['notificationAttemptedAt']=stamp;atomic_receipt(path,receipt)
   try:
    if notifier:notifier()
    else:subprocess.run([str(root/'incident-notify.sh'),'info','Samantha — recette nocturne à vérifier.'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,check=False)
   except (OSError,subprocess.SubprocessError):pass
  atomic_receipt(path,receipt);retain(state)
  return {'state':receipt['state'],'receipt':path.name,'attention':sum(r['state']=='attention' for r in receipt['drift'])},0 if receipt['state']=='ok' else 1

def health_view(state,now):
 latest=next(iter(heapq.nlargest(1,nightly_files(state),key=lambda p:p.name)),None) if state.is_dir() else None
 row=read_receipt(latest) if latest else None
 try:
  at=dt.datetime.fromisoformat(row['at']);seconds=at.timestamp()
  if at.tzinfo is None or seconds>now+30:raise ValueError()
  freshness=now-seconds
  if freshness>36*3600:return {'state':'stale','reason':'nightly_acceptance_stale','checked_at':seconds,'freshness_s':freshness}
  mapped={'ok':'healthy','attention':'attention','failed':'degraded'}.get(row['state'],'unverified')
  return {'state':mapped,'reason':'nightly_acceptance_'+row['state'] if row['state'] in ('ok','attention','failed') else 'nightly_acceptance_incomplete','checked_at':seconds,'freshness_s':freshness}
 except (TypeError,KeyError,ValueError,OverflowError):return {'state':'unverified','reason':'nightly_acceptance_unavailable','checked_at':None,'freshness_s':None}

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--secret-root',action='append',default=[],metavar='LABEL=ABSOLUTE_PATH')
 args=parser.parse_args();roots=[]
 for value in args.secret_root:
  label,sep,path=value.partition('=')
  if not sep:parser.error('invalid_secret_root')
  roots.append((label,path))
 try:roots=secret_hook().explicit_roots(roots)
 except ValueError:parser.error('invalid_secret_root')
 try:result,code=execute(Path.home()/'.openclaw/deploys',Path(__file__).resolve().parent,secret_roots=roots)
 except (OSError,ValueError):result,code={'state':'failed','reason':'nightly_storage_unavailable'},2
 print(json.dumps(result));return code
if __name__=='__main__':sys.exit(main())
