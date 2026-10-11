"""J1 hook: explicit roots, closed diagnostics and existing nightly receipt history."""
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

MAX_ROWS=1000
MAX_PATH=8192
SCAN_TIMEOUT=12
TYPES={'token','private_key','jwt','otp','card','email'}

def scanner_owner(root):
 spec=importlib.util.spec_from_file_location('nightly_secret_owner',root/'workspace-secret-scan.py')
 owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
 return owner

def explicit_roots(rows):
 roots=[]
 if len(rows)>8:raise ValueError('secret_roots_limit')
 for label,path in rows:
  if not isinstance(label,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}',label) or not isinstance(path,(str,Path)) or not Path(path).is_absolute() or '\0' in str(path):raise ValueError('invalid_secret_root')
  roots.append((label,str(path)))
 return roots

def closed_scan(raw,owner):
 if not isinstance(raw,dict) or type(raw.get('schemaVersion')) is not int or raw.get('schemaVersion')!=1 or raw.get('state') not in ('ok','partial'):raise ValueError('invalid_secret_scan')
 out={'schemaVersion':1,'state':raw['state'],'findings':[],'warnings':[],'accepted':[],'stats':{}}
 rows=raw.get('findings');warnings=raw.get('warnings');accepted=raw.get('accepted',[])
 policy={(row['path'],row['hash']):row['raison'] for row in owner.accepted_signature_rows() if row['type']=='card'}
 if not isinstance(rows,list) or not isinstance(warnings,list) or not isinstance(accepted,list) or len(rows)+len(warnings)+len(accepted)>MAX_ROWS:raise ValueError('invalid_secret_scan_rows')
 for key,items in [('findings',rows),('warnings',warnings),('accepted',accepted)]:
  for row in items:
   if not isinstance(row,dict) or row.get('type') not in TYPES or (row['type']=='email')!=(key=='warnings'):raise ValueError('invalid_secret_scan_type')
   path=row.get('path');line=row.get('line');digest=row.get('hash')
   if not isinstance(path,str) or not path or len(path)>MAX_PATH or PurePosixPath(path).is_absolute() or any(part in ('.','..') for part in path.split('/')) or any(ord(c)<32 for c in path):raise ValueError('invalid_secret_scan_path')
   if not isinstance(line,int) or isinstance(line,bool) or not 1<=line<=1048576 or not isinstance(digest,str) or not re.fullmatch('[0-9a-f]{16}',digest):raise ValueError('invalid_secret_scan_metadata')
   if key=='accepted' and (row['type']!='card' or (path,digest) not in policy):raise ValueError('invalid_secret_scan_acceptance')
   # Defend the receipt boundary too: a replaced scanner cannot echo a value in a path.
   safe='/'.join(owner.safe_name(part) for part in path.split('/'))
   projection={'path':safe,'line':line,'type':row['type'],'hash':digest}
   if key=='accepted':projection['raison']=policy[(path,digest)]
   out[key].append(projection)
 stats=raw.get('stats')
 if not isinstance(stats,dict):raise ValueError('invalid_secret_scan_stats')
 for key,limit in [('files',10000),('bytes',64*1024*1024),('entries',20000),('skipped',20000)]:
  value=stats.get(key)
  if not isinstance(value,int) or isinstance(value,bool) or not 0<=value<=limit:raise ValueError('invalid_secret_scan_stats')
  out['stats'][key]=value
 return out

def signatures(rows):
 return {hashlib.sha256(json.dumps([r['path'],r['line'],r['type'],r['hash']],ensure_ascii=True,separators=(',',':')).encode()).hexdigest() for r in rows}

def execute_scan(root,roots,history,runner):
 if not roots:return {'state':'not_configured'},False
 roots=explicit_roots(roots)
 if not (root/'workspace-secret-scan.py').is_file():return {'state':'unavailable','reason':'secret_scan_not_installed'},True
 try:
  owner=scanner_owner(root)
  command=[sys.executable,str(root/'workspace-secret-scan.py')]
  for label,path in roots:command.extend(['--root',label+'='+path])
  code,raw=runner(command,SCAN_TIMEOUT)
  out=closed_scan(raw,owner)
  expected=1 if out['findings'] else 2 if out['state']=='partial' else 0
  if code!=expected:raise ValueError('secret_scan_exit_mismatch')
  known=set()
  for receipt in history:
   try:previous=closed_scan(receipt.get('secretScan'),owner)
   except (ValueError,AttributeError):continue
   known.update(signatures(previous['findings']))
  out['newFindingCount']=len(signatures(out['findings'])-known)
  return out,out['newFindingCount']>0 or out['state']=='partial'
 except (OSError,ValueError,TimeoutError,subprocess.SubprocessError):
  return {'state':'unavailable','reason':'secret_scan_unavailable'},True
