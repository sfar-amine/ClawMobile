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

if __name__=='__main__':unittest.main()
