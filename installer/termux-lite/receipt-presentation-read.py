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
# Closed values mirrored from samantha-ui-playbooks skill_intelligence/receipt_presentation.py (HS3 v1).
SLOT_VALUES={'operator':('orange','tt','zain'),'provider':('topnet','steg','sonede')}
AMOUNT=re.compile(r'^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$')
MASKED=re.compile(r'^•• ?\d{2,4}$')
STEP_IDS={'unknown','resolution','route_selection','execution','owner_confirmation_consumed','payment_record_created','financial_dispatch_committed','provider_session_started','provider_session_authenticated','invoice_revalidated','checkout_prepared','browser_context_ready','three_ds2_preflight','gateway_submission_started','gateway_submission_result','bank_ui_opened','bank_return_detected','bank_return_requested','bank_return_response','bank_result_presented','provider_callback_correlated','provider_readback','completion_classified','execution_error','bank_timeout_reconciliation_started','bank_resume_started'}
NOT_DONE=('payment_not_submitted','not_started')
def closed_slots(raw):
 slots={}
 for key,allowed in SLOT_VALUES.items():
  if raw.get(key) in allowed:slots[key]=raw[key]
 amount=raw.get('amountTnd')
 if isinstance(amount,str) and AMOUNT.fullmatch(amount) and float(amount)>0:slots['amountTnd']=amount
 who=raw.get('beneficiary')
 if who=='owner' or (isinstance(who,str) and MASKED.fullmatch(who)):slots['beneficiary']=who
 return slots
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
 slots=closed_slots(u['slots'])
 summary=u.get('text') if text(u.get('text'),240) else None
 alternatives=[];seen={cid}
 for row in rows:
  if not isinstance(row,dict) or not identifier(row.get('capability')) or not text(row.get('label'),200) or row['capability'] in seen:return None
  seen.add(row['capability']);alternatives.append({'capability':row['capability'],'label':row['label']})
 result={key:p[key] for key in ('version','locale','status','label','title','spoken')}
 result.update(rows=[],primary={'label':primary['label'],'action':'done'},effect={'debited':'unknown','source':'receipt'},meta={'capability':cid},understood={'capability':cid,'label':u['label'],'slots':slots,**({'text':summary} if summary else {})},alternatives=alternatives)
 if p['status']=='error':
  failure=p.get('failure')
  if not isinstance(failure,dict) or not text(failure.get('step'),200) or not text(failure.get('reason'),240):return None
  result['failure']={key:failure[key] for key in ('step','reason')}
  if failure.get('stepId') in STEP_IDS:result['failure']['stepId']=failure['stepId']
  done=failure.get('notDone')
  if isinstance(done,dict) and done.get('code')=='unknown':result['failure']['notDone']={'code':'unknown'}
  elif isinstance(done,dict) and done.get('code') in NOT_DONE and text(done.get('text'),200):result['failure']['notDone']={'code':done['code'],'text':done['text']}
 return {'presentation':result,'understood':result['understood'],'alternatives':alternatives,**({'failure':result['failure']} if 'failure' in result else {})}
def display(metadata):
 if not metadata:return None
 p=metadata['presentation'];u=p['understood']
 lines=[u['text']] if u.get('text') and u.get('capability') else []
 return '\n'.join(lines+[p['title'],p['spoken']])
