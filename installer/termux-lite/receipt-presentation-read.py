"""Closed HS3 transport reader, generic subset only until owner fixtures qualify families."""
import importlib.util
import json
from pathlib import Path
import re
spec=importlib.util.spec_from_file_location('_hs3_acceptance',Path(__file__).with_name('companion-acceptance.py'))
acceptance=importlib.util.module_from_spec(spec);spec.loader.exec_module(acceptance)
LEAK=acceptance.LEAK
ID=re.compile(r'^[a-z][a-z0-9_.-]{0,159}$')
PRIVATE=re.compile(r'(?i)(?:ghp_|github_pat_|AKIA|eyJ)[A-Za-z0-9_.-]+|@|[\x00-\x1f]')
def text(value,limit):
 return isinstance(value,str) and 0<len(value)<=limit and not LEAK.search(value) and not PRIVATE.search(value) and len(re.findall(r'\d',value))<6 and not value.startswith(('{','['))
def identifier(value):return isinstance(value,str) and ID.fullmatch(value) and not LEAK.search(value) and not PRIVATE.search(value)
def read(raw):
 if not isinstance(raw,dict):return None
 p=raw.get('presentation')
 if not isinstance(p,dict) or type(p.get('version')) is not int or p.get('version')!=1 or p.get('locale') not in ('fr','en') or p.get('status') not in ('info','error'):return None
 if not all(text(p.get(k),n) for k,n in [('label',200),('title',200),('spoken',240)]):return None
 if p.get('rows')!=[]:return None
 primary=p.get('primary');u=p.get('understood');meta=p.get('meta');effect=p.get('effect');rows=p.get('alternatives')
 if not all(isinstance(x,dict) for x in (primary,u,meta,effect)) or not isinstance(rows,list) or len(rows)>3:return None
 if primary.get('action')!='done' or not text(primary.get('label'),200) or effect.get('debited')!='unknown' or effect.get('source')!='receipt':return None
 cid=u.get('capability')
 if (cid is not None and not identifier(cid)) or meta.get('capability')!=cid or not text(u.get('label'),200) or not isinstance(u.get('slots'),dict):return None
 slots={}
 for key,allowed in [('operator',('orange','tt','zain')),('line',('owner',))]:
  value=u['slots'].get(key)
  if isinstance(value,str) and value in allowed:slots[key]=value
 alternatives=[];seen={cid}
 for row in rows:
  if not isinstance(row,dict) or not identifier(row.get('capability')) or not text(row.get('label'),200) or row['capability'] in seen:return None
  seen.add(row['capability']);alternatives.append({'capability':row['capability'],'label':row['label']})
 result={key:p[key] for key in ('version','locale','status','label','title','spoken')}
 result.update(rows=[],primary={'label':primary['label'],'action':'done'},effect={'debited':'unknown','source':'receipt'},meta={'capability':cid},understood={'capability':cid,'label':u['label'],'slots':slots},alternatives=alternatives)
 if p['status']=='error':
  failure=p.get('failure')
  if not isinstance(failure,dict) or not text(failure.get('step'),200) or not text(failure.get('reason'),240):return None
  result['failure']={key:failure[key] for key in ('step','reason')}
 return {'presentation':result,'understood':result['understood'],'alternatives':alternatives,**({'failure':result['failure']} if 'failure' in result else {})}
def display(metadata):
 if not metadata:return None
 p=metadata['presentation'];return p['title']+'\n'+p['spoken']
