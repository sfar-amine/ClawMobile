"""J1 hook: explicit roots, closed diagnostics and existing nightly receipt history."""
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time

MAX_ROWS=1000
MAX_PATH=8192
SCAN_TIMEOUT=12
# Existing runner cleanup can take 2 s wait + 2 s descendant termination.
SCAN_CLEANUP_MARGIN=4
SCAN_JOB_TIMEOUT=8*(SCAN_TIMEOUT+SCAN_CLEANUP_MARGIN)
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
  if any(existing==label for existing,_ in roots):raise ValueError('duplicate_secret_root')
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
 # Old receipts have no root diagnostics; the optional new projection is closed.
 roots=raw.get('roots')
 if roots is not None:
  if not isinstance(roots,list) or len(roots)>8:raise ValueError('invalid_secret_scan_roots')
  projected=[];labels=set();totals={key:0 for key in out['stats']}
  for row in roots:
   if not isinstance(row,dict) or set(row)!={'label','state','budgetMs','durationMs','stats'}:raise ValueError('invalid_secret_scan_root')
   label=row['label']
   if not isinstance(label,str) or not label or len(label)>96 or '/' in label or any(ord(c)<32 for c in label):raise ValueError('invalid_secret_scan_root_label')
   safe=owner.safe_name(label)
   if safe in labels or row['state'] not in ('ok','partial'):raise ValueError('invalid_secret_scan_root_state')
   labels.add(safe)
   for key,maximum in [('budgetMs',10000),('durationMs',SCAN_JOB_TIMEOUT*1000)]:
    if type(row[key]) is not int or not 0<=row[key]<=maximum:raise ValueError('invalid_secret_scan_root_time')
   if row['stats'] is None:
    if row['state']!='partial':raise ValueError('invalid_secret_scan_root_stats')
    projected.append({'label':safe,'state':'partial','budgetMs':row['budgetMs'],'durationMs':row['durationMs'],'stats':None})
    continue
   if not isinstance(row['stats'],dict):raise ValueError('invalid_secret_scan_root_stats')
   stats={}
   for key,maximum in [('files',10000),('bytes',64*1024*1024),('entries',20000),('skipped',20000)]:
    value=row['stats'].get(key)
    if type(value) is not int or not 0<=value<=maximum:raise ValueError('invalid_secret_scan_root_stats')
    stats[key]=value;totals[key]+=value
   projected.append({'label':safe,'state':row['state'],'budgetMs':row['budgetMs'],'durationMs':row['durationMs'],'stats':stats})
  if totals!=out['stats'] or (out['state']=='ok' and any(row['state']!='ok' for row in projected)):raise ValueError('invalid_secret_scan_root_totals')
  out['roots']=projected
 return out

def signatures(rows):
 return {hashlib.sha256(json.dumps([r['path'],r['line'],r['type'],r['hash']],ensure_ascii=True,separators=(',',':')).encode()).hexdigest() for r in rows}

def execute_scan(root,roots,history,runner):
 if not roots:return {'state':'not_configured'},False
 roots=explicit_roots(roots)
 if not (root/'workspace-secret-scan.py').is_file():return {'state':'unavailable','reason':'secret_scan_not_installed'},True
 try:owner=scanner_owner(root)
 except (OSError,ValueError,ImportError):return {'state':'unavailable','reason':'secret_scan_unavailable'},True
 out={'schemaVersion':1,'state':'ok','findings':[],'warnings':[],'accepted':[],
      'stats':{'files':0,'bytes':0,'entries':0,'skipped':0},'roots':[]}
 deadline=time.monotonic()+SCAN_JOB_TIMEOUT
 limits={'files':10000,'bytes':64*1024*1024,'entries':20000,'findings':MAX_ROWS}
 consumed={key:0 for key in limits}
 for index,(label,path) in enumerate(roots):
  started=time.monotonic();remaining_roots=len(roots)-index
  shares={key:max(0,maximum-consumed[key])//remaining_roots for key,maximum in limits.items()}
  timeout=min(SCAN_TIMEOUT,max(0,deadline-started-SCAN_CLEANUP_MARGIN))
  seconds=min(10,max(0,timeout-2))
  diagnostic={'label':owner.safe_name(label),'state':'partial','budgetMs':int(seconds*1000),'durationMs':0,
              'stats':None}
  try:
   if not seconds or not all(shares.values()):raise TimeoutError('secret_scan_budget_exhausted')
   command=[sys.executable,str(root/'workspace-secret-scan.py'),'--root',label+'='+path,'--seconds',str(seconds)]
   for key,maximum in shares.items():command.extend(['--max-'+key,str(maximum)])
   code,raw=runner(command,timeout)
   projection=closed_scan(raw,owner)
   expected=1 if projection['findings'] else 2 if projection['state']=='partial' else 0
   if code!=expected:raise ValueError('secret_scan_exit_mismatch')
   if any(projection['stats'][key]>shares[key] for key in ('files','bytes','entries')) or sum(len(projection[key]) for key in ('findings','warnings','accepted'))>shares['findings']:raise ValueError('secret_scan_partition_limit')
   prefix=owner.safe_name(label)+'/'
   if any(not row['path'].startswith(prefix) for key in ('findings','warnings','accepted') for row in projection[key]):raise ValueError('secret_scan_partition_path')
   diagnostic['state']=projection['state'];diagnostic['stats']=projection['stats']
   for key in ('findings','warnings','accepted'):out[key].extend(projection[key])
   for key in out['stats']:out['stats'][key]+=projection['stats'][key]
   for key in consumed:consumed[key]+=sum(len(projection[k]) for k in ('findings','warnings','accepted')) if key=='findings' else projection['stats'][key]
  except (OSError,ValueError,TimeoutError,subprocess.SubprocessError):
   # A failed root is explicitly partial; it cannot erase earlier findings or
   # prevent subsequent roots from being visited within the same bounded job.
   # No trustworthy counters returned: reserve the entire granted share.
   # Failed scans therefore cannot multiply the global read/row budget.
   for key in consumed:consumed[key]+=shares[key]
  diagnostic['durationMs']=int(max(0,time.monotonic()-started)*1000)
  if diagnostic['state']=='partial':out['state']='partial'
  out['roots'].append(diagnostic)
 known=set()
 for receipt in history:
  try:previous=closed_scan(receipt.get('secretScan'),owner)
  except (ValueError,AttributeError):continue
  known.update(signatures(previous['findings']))
 out['newFindingCount']=len(signatures(out['findings'])-known)
 return out,out['newFindingCount']>0 or out['state']=='partial'
