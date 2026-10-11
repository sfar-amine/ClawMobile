#!/usr/bin/env python3
"""Read-only UI smoke with canonical admission (lease, package, unlocked, awake,
idle owner, Samantha in foreground). Only fixed source-audited navigation tags
are clickable. UI dumps never leave memory: uiautomator writes to /dev/tty.
"""
import argparse,fcntl,json,os,re,subprocess,time,urllib.request,urllib.error,xml.etree.ElementTree as ET
from pathlib import Path
# Installed package confirmed on the S24 (11/10): ai.samantha.android.dev 0.10.1-native-dev-opt.
PACKAGE='ai.samantha.android.dev'
ADB_SERIAL=os.environ.get('SAMANTHA_ADB_ENDPOINT','127.0.0.1:5556')
# Existing shared UI lease (samantha-ui-playbooks qa_testing/executors.py SHARED_UI_LOCK,
# billing/auth_guard.py execution_lock): one UI driver at a time, non-blocking.
SHARED_UI_LOCK=Path.home()/'.openclaw/billing-auth/execution.lock'
IDLE_MIN_MS=60_000
MAX_XML=2*1024*1024
# Audited on app source 7da197541660fef79dc3e9dd05a898bfc9da3d98.
NAVIGATION=frozenset(('tab-home','open-settings','agent-settings-row','usage-row','providers-row','files-row','usage-cost'))
SEARCH=frozenset(('automations-search','files-search'))
FORBIDDEN=re.compile(r'pay|paiement|bank|banque|recharg|top.?up|exécuter|execute|supprimer|delete|save|enregistrer|switch|toggle|send|envoi|confirm',re.I)
SCREENS=(('usage',('open-settings','agent-settings-row','usage-row'),'usage-screen','/usage'),('providers',('open-settings','agent-settings-row','providers-row'),'providers-screen','/providers'),('files',('open-settings','agent-settings-row','files-row'),'files-screen','/files?scope=agent'))
class SmokeError(Exception):pass

class SharedUiLease:
 """Held for the whole run; refused (never waited) when another UI driver owns it."""
 def __init__(self,path=None):self.path=Path(path or SHARED_UI_LOCK);self.fd=None
 def __enter__(self):
  try:
   self.path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
   self.fd=os.open(self.path,os.O_CREAT|os.O_RDWR,0o600)
  except OSError:raise SmokeError('shared_ui_lease_unavailable')
  try:fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:
   os.close(self.fd);self.fd=None;raise SmokeError('shared_ui_busy')
  return self
 def __exit__(self,*exc):
  if self.fd is not None:os.close(self.fd);self.fd=None

def parse_package(text):
 name=re.search(r'(?m)^\s*versionName=(\S+)\s*$',text or '');code=re.search(r'(?m)^\s*versionCode=(\d+)\b',text or '')
 if not name or not code:raise SmokeError('package_not_installed')
 return {'package':PACKAGE,'versionName':name.group(1)[:64],'versionCode':int(code.group(1))}

def parse_keyguard(text):
 shown=re.findall(r'(?m)^\s+showing=(true|false)\s*$',text or '')
 if shown!=['false']:raise SmokeError('device_locked_or_unknown')

def parse_idle(power,uptime):
 wake=re.search(r'(?m)^\s*mWakefulness=(\w+)\s*$',power or '')
 if not wake or wake.group(1)!='Awake':raise SmokeError('screen_not_awake')
 last=re.search(r'mLastUserActivityTime(?:\(excludingAttention\))?=(\d+)',power or '')
 up=re.match(r'\s*(\d+(?:\.\d+)?)\s',uptime or '')
 if not last or not up:raise SmokeError('user_activity_unknown')
 idle=int(float(up.group(1))*1000)-int(last.group(1))
 if idle<0:raise SmokeError('user_activity_unknown')
 if idle<IDLE_MIN_MS:raise SmokeError('recent_user_activity')
 return idle

def parse_focus(text):
 match=re.search(r'mCurrentFocus=Window\{[0-9a-f]+ u\d+ ([A-Za-z0-9_.]+)/[A-Za-z0-9_.$]+\}',text or '')
 if not match or match.group(1)!=PACKAGE:raise SmokeError('foreground_not_samantha')

def admission(adb,deadline):
 """Read-only probes only (dumpsys, uptime). Any unknown answer refuses."""
 package=parse_package(adb.call(['shell','dumpsys','package',PACKAGE],deadline).decode(errors='replace'))
 parse_keyguard(adb.call(['shell','dumpsys','window','policy'],deadline).decode(errors='replace'))
 idle=parse_idle(adb.call(['shell','dumpsys','power'],deadline).decode(errors='replace'),adb.call(['shell','cat','/proc/uptime'],deadline).decode(errors='replace'))
 adb.foreground(deadline)
 return {**package,'idleMs':idle,'foreground':PACKAGE,'lease':'shared_ui'}

def parse_dump(raw):
 if len(raw)>MAX_XML or b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:raise SmokeError('invalid_dump')
 start=raw.find(b'<?xml');end=raw.find(b'</hierarchy>')
 if start<0 or end<start:raise SmokeError('missing_dump')
 try:return ET.fromstring(raw[start:end+12])
 except ET.ParseError:raise SmokeError('invalid_dump')

def find_tag(tree,tag):
 # Synthetic admission boundary: package ownership must hold for the whole
 # visible hierarchy, not just a node behind another app's overlay. This is
 # insufficient as a runtime lease, so live CLI admission remains disabled.
 nodes=list(tree.iter('node'))
 if tree.get('package') not in (None,PACKAGE) or any(n.get('package')!=PACKAGE for n in nodes):raise SmokeError('foreground_not_verified')
 matches=[n for n in nodes if n.get('resource-id') in (tag,PACKAGE+':id/'+tag)]
 if len(matches)!=1:raise SmokeError('tag_not_exposed_or_ambiguous')
 node=matches[0]
 if node.get('package')!=PACKAGE or node.get('enabled')!='true':raise SmokeError('unsafe_node')
 return node

def inspect(tree,status):
 texts=[n.get('text','')+' '+n.get('content-desc','') for n in tree.iter('node') if n.get('package')==PACKAGE]
 errors=[];warnings=[]
 if status is None:errors.append('route_not_verified')
 if status==200 and any('indisponible' in s.lower() for s in texts):errors.append('unavailable_after_http_200')
 if any('**' in s or re.search(r'[\[{]\s*["\w]+\s*[":]',s) for s in texts):errors.append('raw_format_displayed')
 if any(re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}',s) for s in texts):warnings.append('email_address_displayed')
 if any(re.search(r'\+?\d[\d ()-]{7,}\d',s) for s in texts):warnings.append('full_number_displayed')
 return {'errors':errors,'warnings':warnings}

class Adb:
 def call(self,args,deadline):
  timeout=min(3,max(0,deadline-time.monotonic()))
  if timeout<=0:raise SmokeError('screen_timeout')
  # Spooled to no file; hard output bound enforced incrementally.
  p=subprocess.Popen(['adb','-s',ADB_SERIAL,*args],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  import selectors,os
  selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ);out=bytearray();end=time.monotonic()+timeout
  try:
   while selector.get_map():
    if time.monotonic()>=end:raise SmokeError('adb_timeout')
    for key,_ in selector.select(min(.1,end-time.monotonic())):
     chunk=os.read(key.fd,8192)
     if not chunk:selector.unregister(key.fileobj);continue
     if len(out)+len(chunk)>MAX_XML:raise SmokeError('adb_output_limit')
     out.extend(chunk)
   if p.wait(timeout=max(.001,end-time.monotonic())):raise SmokeError('adb_failed')
   return bytes(out)
  finally:
   selector.close();p.stdout.close()
   if p.poll() is None:p.kill()
   p.wait(timeout=1)
 def dump(self,deadline):return parse_dump(self.call(['exec-out','uiautomator','dump','/dev/tty'],deadline))
 def foreground(self,deadline):
  # Rechecked before every input: the owner may have taken the phone back.
  parse_focus(self.call(['shell','dumpsys window | grep -m1 mCurrentFocus'],deadline).decode(errors='replace'))
 def tap(self,tag,deadline):
  if tag not in NAVIGATION or FORBIDDEN.search(tag):raise SmokeError('action_forbidden')
  self.foreground(deadline)
  node=find_tag(self.dump(deadline),tag)
  if FORBIDDEN.search(node.get('text','')+' '+node.get('content-desc','')):raise SmokeError('action_forbidden')
  match=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds',''))
  if not match:raise SmokeError('invalid_bounds')
  x,y,right,bottom=map(int,match.groups())
  if not (0<=x<right<=10000 and 0<=y<bottom<=10000):raise SmokeError('invalid_bounds')
  self.call(['shell','input','tap',str((x+right)//2),str((y+bottom)//2)],deadline)
 def search(self,tag,text,deadline):
  if tag not in SEARCH or not re.fullmatch(r'[A-Za-z0-9]{1,40}',text):raise SmokeError('text_forbidden')
  # No text transport until an audited search node is exposed; no general input.
  node=find_tag(self.dump(deadline),tag)
  if node.get('class')!='android.widget.EditText':raise SmokeError('text_forbidden')
  match=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds',''))
  if not match:raise SmokeError('invalid_bounds')
  a,b,c,d=map(int,match.groups())
  if not (0<=a<c<=10000 and 0<=b<d<=10000):raise SmokeError('invalid_bounds')
  self.foreground(deadline)
  self.call(['shell','input','tap',str((a+c)//2),str((b+d)//2)],deadline)
  self.call(['shell','input','text',text],deadline)
 def home(self):self.call(['shell','input','keyevent','KEYCODE_HOME'],time.monotonic()+3)

def http_status(route,deadline):
 timeout=min(6,max(.001,deadline-time.monotonic()))
 try:
  class NoRedirect(urllib.request.HTTPRedirectHandler):
   def redirect_request(self,*args,**kwargs):return None
  with urllib.request.build_opener(NoRedirect()).open('http://127.0.0.1:8765/v1'+route,timeout=timeout) as response:return response.status
 except urllib.error.HTTPError as error:return error.code
 except (OSError,TimeoutError):return None

def run(adb,probe=http_status):
 results=[]
 try:
  for name,path,screen,route in SCREENS:
   start=time.monotonic();deadline=start+14.5
   try:
    adb.tap('tab-home',deadline)
    for tag in path:adb.tap(tag,deadline)
    tree=adb.dump(deadline);find_tag(tree,screen)
    status=probe(route,deadline);view=inspect(tree,status)
    if time.monotonic()>=deadline:view['errors'].append('screen_timeout')
    results.append({'screen':name,'seconds':round(time.monotonic()-start,2),'httpStatus':status,**view})
   except (SmokeError,OSError,subprocess.SubprocessError):results.append({'screen':name,'errors':['screen_not_verified'],'warnings':[]})
 finally:
  try:adb.tap('tab-home',time.monotonic()+3)
  except (SmokeError,OSError,subprocess.SubprocessError):pass
  finally:adb.home()
 return {'state':'failed' if any(r['errors'] for r in results) else 'ok','screens':results}

def main(adb_factory=None,lease_factory=None):
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--run',action='store_true');args=parser.parse_args()
 if not args.run:
  print(json.dumps({'state':'not_run','reason':'run_flag_required'}));return 2
 adb=(adb_factory or Adb)()
 try:
  with (lease_factory or SharedUiLease)():
   try:admitted=admission(adb,time.monotonic()+12)
   except (OSError,subprocess.SubprocessError):raise SmokeError('admission_unverified')
   out=run(adb)
 except SmokeError as error:
  # Closed reason only: no dump, UI text or stderr.
  print(json.dumps({'state':'not_run','reason':str(error)}));return 2
 print(json.dumps({**out,'admission':admitted}));return 0 if out['state']=='ok' else 1
if __name__=='__main__':raise SystemExit(main())
