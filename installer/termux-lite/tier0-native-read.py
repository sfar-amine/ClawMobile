"""Native facade over tier0-control, without download/package/alternate release authority."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import argparse,hashlib,importlib.util,json,re,subprocess,datetime,os,stat

ID=re.compile(r'[A-Za-z0-9_-]{1,100}')
def owner(home):
 spec=importlib.util.spec_from_file_location('tier0_owner',Path(__file__).with_name('tier0-control.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.HOME=home;module.TIER0=home/'.openclaw/tier0';module.RELEASES=home/'.openclaw/releases';module.STATE=module.TIER0/'state.json';module.STOP=module.TIER0/'emergency-stop.json';module.CURRENT=module.RELEASES/'current';module.LKG=module.RELEASES/'last-known-good';return module

def release(module,identifier):
 if not isinstance(identifier,str) or not ID.fullmatch(identifier):raise ValueError('invalid_release')
 root=module.RELEASES/identifier
 if root.is_symlink() or not root.is_dir() or not root.resolve().is_relative_to(module.RELEASES.resolve()):raise ValueError('invalid_release')
 file=root/'manifest.json'
 if file.is_symlink() or file.stat().st_size>2_000_000:raise ValueError('invalid_manifest')
 data=json.loads(file.read_text());rows=data.get('files')
 if data.get('release_id')!=identifier or not isinstance(rows,dict) or len(rows)>10000:raise ValueError('invalid_manifest')
 for name,row in rows.items():
  path=Path(name)
  if path.is_absolute() or '..' in path.parts or not isinstance(row,dict):raise ValueError('invalid_manifest')
  current=root
  for part in path.parts:
   current=current/part
   if current.is_symlink():raise ValueError('invalid_manifest')
  if not current.resolve().is_relative_to(root.resolve()):raise ValueError('invalid_manifest')
 module.verify_release(root)
 commit=data.get('source_commit')
 return {'id':identifier,'createdAt':data.get('created_at') if re.fullmatch(r'[0-9T:Z+.-]{10,40}',str(data.get('created_at',''))) else None,
         'sourceCommit':commit if re.fullmatch(r'[a-f0-9]{40}',str(commit)) else None,'verified':True}

MAX_VERIFIED=10
def created(value):
 try:return datetime.datetime.fromisoformat(str(value).replace('Z','+00:00')).timestamp()
 except (ValueError,TypeError):return None
def newer_than(path,current):
 """Cheap pre-filter from the manifest date only; the full verification still runs on what passes."""
 base=created(current.get('createdAt'))
 if base is None:return True
 try:
  file=path/'manifest.json'
  if file.is_symlink() or file.stat().st_size>2_000_000:return False
  at=created(json.loads(file.read_text()).get('created_at'))
 except (OSError,ValueError):return False
 return at is not None and at>base

def selected(module,link):
 if not link.exists():return None
 target=link.resolve()
 if target.parent!=module.RELEASES.resolve():raise ValueError('release_outside_owner')
 return release(module,target.name)

def read(module):
 current=selected(module,module.CURRENT);lkg=selected(module,module.LKG);rows=[]
 state={}
 if module.STATE.exists():
  fd=os.open(module.STATE,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  with os.fdopen(fd,'rb') as stream:
   info=os.fstat(stream.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_size>65536:raise ValueError('invalid_tier0_state')
   raw=stream.read(65537)
  if len(raw)>65536:raise ValueError('invalid_tier0_state')
  state=json.loads(raw)
  if not isinstance(state,dict):raise ValueError('invalid_tier0_state')
 blocked=set()
 for key in ('rolled_back_from','last_bad'):
  value=state.get(key)
  for identifier in value if isinstance(value,list) else [value]:
   if isinstance(identifier,str) and ID.fullmatch(identifier):blocked.add(identifier)
 if module.RELEASES.is_dir():
  for path in sorted((path for path in module.RELEASES.iterdir() if path.name not in {'current','last-known-good'} and not path.is_symlink() and ID.fullmatch(path.name) and path.name not in blocked),reverse=True):
   if path.name in {'current','last-known-good'} or path.is_symlink() or not ID.fullmatch(path.name):continue
   # Only releases newer than current can be an update: older ones are never re-hashed (110+ on the S24).
   if current is not None and not newer_than(path,current):continue
   if len(rows)>=MAX_VERIFIED:break
   try:rows.append(release(module,path.name))
   except (OSError,ValueError,RuntimeError,KeyError):continue
 return {'schemaVersion':1,'current':current,'lastKnownGood':lkg,'available':rows,
         'updateAvailable':None,'updateReason':'tier0_soak_rolled_back' if state.get('soak_state')=='rolled_back' else None,'versionSource':'tier0_manifest_verified','activationQualified':False}

def updates_snapshot(home,companion_version=None):
 module=owner(home);issues=[]
 try:value=read(module)
 except (OSError,ValueError,RuntimeError,KeyError,TypeError,SystemExit):
  value={'current':None,'lastKnownGood':None,'available':[],'activationQualified':False};issues.append('tier0_owner_unavailable')
 current=value['current']
 def at(row):
  try:return datetime.datetime.fromisoformat(row['createdAt'].replace('Z','+00:00')).timestamp()
  except (ValueError,TypeError,KeyError):return None
 current_at=at(current) if current else None
 newer=[row for row in value['available'] if current_at is not None and at(row) is not None and at(row)>current_at and row['id']!=current['id']]
 value['updateAvailable']=None if value.get('updateReason')=='tier0_soak_rolled_back' else bool(newer) if current_at is not None else None
 if value.get('updateReason'):issues.append(value['updateReason'])
 value['available']=sorted(newer,key=at,reverse=True)[:100]
 revision=None;pin=home/'.openclaw/runtime-ui-playbooks/current'
 try:
  target=pin.resolve(strict=True)
  if target.parent!=(home/'.openclaw/runtime-ui-playbooks').resolve() or not (target/'reporting/control_snapshot.py').is_file():raise ValueError()
  run=subprocess.run(['git','-C',str(target),'rev-parse','--verify','HEAD'],capture_output=True,text=True,timeout=1)
  candidate=run.stdout.strip()
  if run.returncode or not re.fullmatch(r'[a-f0-9]{40}',candidate):raise ValueError()
  revision=candidate
 except (OSError,ValueError,subprocess.TimeoutExpired):issues.append('playbooks_version_unavailable')
 version=companion_version if isinstance(companion_version,str) and re.fullmatch(r'\d{1,5}\.\d{1,5}\.\d{1,5}(?:[-+][A-Za-z0-9.-]{1,50})?',companion_version) else None
 items=[{'id':'app','label':'Samantha Android','version':None,'source':'android','reason':'app_version_owned_by_android'},
        {'id':'companion','label':'Companion','version':version,'source':'installed_package','reason':None if version else 'companion_version_unavailable'},
        {'id':'playbooks','label':'Playbooks','version':revision,'source':'pinned_runtime','reason':None if revision else 'playbooks_version_unavailable'},
        {'id':'termux-lite','label':'Termux-lite','version':current['sourceCommit'] if current else None,'source':'tier0_manifest_verified','reason':None if current and current['sourceCommit'] else 'termux_version_unavailable'}]
 return {'success':True,'state':'partial' if issues or any(row['reason'] for row in items) else 'ok','receipt':None,**value,'items':items,'issues':issues,'actions':[]}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--home',type=Path,default=Path.home());parser.add_argument('--companion-version');args=parser.parse_args()
 try:print(json.dumps(updates_snapshot(args.home,args.companion_version)));return 0
 except (OSError,ValueError,RuntimeError,KeyError,TypeError):print(json.dumps({'success':False,'state':'unavailable','receipt':None,'error':'updates_unavailable'}));return 1
if __name__=='__main__':raise SystemExit(main())
