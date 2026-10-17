#!/usr/bin/env python3
"""Bounded native Web handoff; synthetic new payload, no network or Gateway."""
import copy,importlib.util,json,sys,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fast_web',Path(__file__).with_name('model-fast-path.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def resolution():
 d={'version':2,'type':'EXECUTE','requestId':'admitted-request','surface':'claw_live','caller':'owner','capability':'samantha.app.web.search','risk':'read'}
 return {'capability':d['capability'],'decision':d,'selected':{'capability':d['capability'],'risk':'read','deterministic':True,'model_required':False,'authorized':True,'state':'ready'},'continuum':{'mode':'immediate'},'harness':{'tool_policy':'required'}}

class WebFastPath(unittest.TestCase):
 def context(self):return {'request_id':'admitted-request','run_id':'actual-run','session_id':'actual-session','remaining_budget_ms':1200,'deadline_epoch_ms':int(time.time()*1000)+1200}
 def test_host_bound_frozen_identity_and_remaining_budget(self):
  calls=[]
  def run(args,**kw):
   calls.append((args,kw));return 0,{'execution':{'state':'completed','result':{'web':{'outcome':'complete'}}},'selected':{'capability':'samantha.app.web.search'}},''
  with patch.object(m,'validate_prepared_decision',return_value={'state':'valid','decision':resolution()['decision'],'resolution':resolution()}),patch.object(m,'_run_json',side_effect=run):
   out=m.try_fast_path('find official announcements',ROOT,prepared_decision=resolution()['decision'],**self.context())
  self.assertEqual(out['status'],'hit');self.assertEqual(out['web']['outcome'],'complete');self.assertEqual(len(calls),1)
  args,kw=calls[0]
  for flag,value in [('--request-id','admitted-request'),('--run-id','actual-run'),('--session-id','actual-session')]:self.assertEqual(args[args.index(flag)+1],value)
  self.assertLessEqual(int(args[args.index('--remaining-budget-ms')+1]),1200);self.assertLessEqual(kw['timeout'],1.2)
  self.assertNotIn('actual-session',out.get('text',''))
 def test_missing_or_forged_context_never_dispatches(self):
  for change in [{'request_id':None},{'request_id':'other'},{'remaining_budget_ms':12001},{'remaining_budget_ms':0},{'deadline_epoch_ms':0},{'caller':'other'}]:
   context=self.context();context.update(change)
   with self.subTest(change=change),patch.object(m,'validate_prepared_decision',return_value={'state':'valid','decision':resolution()['decision'],'resolution':resolution()}),patch.object(m,'execute_capability_decision') as execute:
    out=m.try_fast_path('find public announcements',ROOT,prepared_decision=resolution()['decision'],**context)
   execute.assert_not_called();self.assertEqual(out['reason'],'invalid_web_execution_context')
 def test_new_web_never_generic_renders_page_or_provider_json(self):
  executed={'execution':{'state':'failed','result':{'web':{'outcome':'failed'},'private':'PRIVATE_CANARY'}},'selected':{'capability':'samantha.app.web.search'}}
  with patch.object(m,'validate_prepared_decision',return_value={'state':'valid','decision':resolution()['decision'],'resolution':resolution()}),patch.object(m,'execute_capability_decision',return_value=executed),patch.object(m,'_display_text',side_effect=AssertionError('generic renderer forbidden')):
   out=m.try_fast_path('public query',ROOT,prepared_decision=resolution()['decision'],**self.context())
  self.assertEqual(out['status'],'known_error');self.assertNotIn('PRIVATE_CANARY',json.dumps(out));self.assertEqual(out['execution_state'],'failed')
 def test_check_only_does_not_require_execution_metadata(self):
  with patch.object(m,'resolve_capability',return_value=resolution()),patch.object(m,'execute_capability_decision') as execute:
   out=m.try_fast_path('public query',ROOT,execute=False)
  self.assertEqual(out['status'],'eligible');execute.assert_not_called()
 def test_durable_read_does_not_escape_its_owner(self):
  r=resolution();r['continuum']={'mode':'durable'}
  with patch.object(m,'validate_prepared_decision',return_value={'state':'valid','decision':r['decision'],'resolution':r}),patch.object(m,'_durable_capability_execute') as execute:
   out=m.try_fast_path('public query',ROOT,prepared_decision=r['decision'],**self.context())
  self.assertEqual(out['execution_state'],'verification_required');execute.assert_not_called()

class WebDialoguePorts(unittest.TestCase):
 """V2.2: the Web hand-off runs through the coordinator's execute port; no parallel clarification authority."""
 def ports(self,**host):
  return m.FastPathPorts(ROOT,surface='claw_live',caller='owner',timeout=30,web_host=host)
 def decision(self):
  d=resolution()['decision'];d['decisionId']='dec-1';return d
 def test_voice_surface_closed_before_dispatch(self):
  for host,ctx in [({'voice_delegation':True},{'surface':'claw_live'}),({},{'surface':'voice'})]:
   with self.subTest(host=host),patch.dict(m.os.environ,{},clear=False),patch.object(m,'execute_capability_decision') as execute,patch.object(m,'try_fast_path') as fast:
    m.os.environ.pop('CLAW_PUBLIC_WEB_VOICE_RECIPE',None)
    out=self.ports(**host).execute('Search online',self.decision(),'dlg1:'+'a'*40,'fast',{**ctx,'caller':'owner'})
   execute.assert_not_called();fast.assert_not_called()
   self.assertEqual(out['status'],'known_error');self.assertEqual(out['web']['error']['code'],'voice_recipe_required');self.assertEqual(out['web']['metrics']['providerAttempts'],0)
 def test_recipe_flag_is_strict(self):
  for value in ('true','yes','0'):
   with self.subTest(value=value),patch.dict(m.os.environ,{'CLAW_PUBLIC_WEB_VOICE_RECIPE':value}):
    self.assertFalse(m.public_web_voice_recipe_enabled())
  with patch.dict(m.os.environ,{'CLAW_PUBLIC_WEB_VOICE_RECIPE':'1'}):self.assertTrue(m.public_web_voice_recipe_enabled())
 def test_app_handoff_binds_host_context_and_renders_sources(self):
  ports=self.ports(run_id='run_1_abcd',session_id='companion-chat-1',deadline_epoch_ms=int(time.time()*1000)+5000)
  r=resolution();d=self.decision();ports._resolutions['dec-1']=r
  web={'outcome':'partial','sources':[{'title':'Annonce officielle','url':'https://news.example.org/a'}],'claims':[],'error':{'message':'La synthèse est temporairement indisponible.'}}
  calls=[]
  def run(message,decision,ui_root,**kw):
   calls.append(kw);return {'execution':{'state':'completed','result':{'web':web}},'selected':{'capability':'samantha.app.web.search'}}
  with patch.object(m,'execute_capability_decision',side_effect=run):
   out=ports.execute('Recherche sur Internet les annonces',d,'dlg1:'+'b'*40,'fast',{'surface':'app','caller':'owner'})
  self.assertEqual(out['status'],'hit');self.assertEqual(out['web'],web);ctx=calls[0]['execution_context']
  self.assertEqual((ctx['request_id'],ctx['run_id'],ctx['session_id']),('admitted-request','run_1_abcd','companion-chat-1'))
  self.assertTrue(0<ctx['remaining_budget_ms']<=5000)
  self.assertIn('Annonce officielle — https://news.example.org/a',out['text']);self.assertIn('synthèse',out['text'])
 def test_forged_host_values_are_ignored_and_budget_capped(self):
  ports=self.ports(run_id='bad id;rm',session_id='x'*200,deadline_epoch_ms=int(time.time()*1000)+60000)
  ctx=ports._web_context(self.decision())
  self.assertIsNone(ctx['run_id']);self.assertIsNone(ctx['session_id']);self.assertLessEqual(ctx['remaining_budget_ms'],12000)
 def test_expired_deadline_never_dispatches(self):
  ports=self.ports();ports.web_deadline_epoch_ms=int(time.time()*1000)-1;ports._resolutions['dec-1']=resolution()
  with patch.object(m,'execute_capability_decision') as execute:
   out=ports.execute('q',self.decision(),'dlg1:'+'c'*40,'fast',{'surface':'app','caller':'owner'})
  execute.assert_not_called();self.assertEqual(out['reason'],'web_deadline_exceeded')
 def test_non_owner_never_dispatches(self):
  ports=self.ports();ports._resolutions['dec-1']=resolution()
  with patch.object(m,'execute_capability_decision') as execute:
   out=ports.execute('q',self.decision(),'dlg1:'+'d'*40,'fast',{'surface':'app','caller':'other'})
  execute.assert_not_called();self.assertEqual(out['reason'],'public_owner_required')

if __name__=='__main__':unittest.main()
