#!/usr/bin/env python3
"""Real private admission across Core durable owner and paired PB Graph, offline provider only."""
import importlib.util,json,os,sys,tempfile,subprocess,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
PB=Path(sys.argv.pop(1)).resolve();sys.path.insert(0,str(PB))
from skill_intelligence.capability_graph import CapabilityGraph
from skill_intelligence.intent_dialogue import make_intent_dialogue_port
from skill_intelligence.dialogue.coordinator import Coordinator,read_handoff_context
from skill_intelligence.dialogue.store import DialogueStore
from tests.test_intent_dialogue import RecordedRunner
from tests.test_intent_interpreter import proposal
from tests.dialogue_fakes import TempStore,Clock,event,open_lock
spec=importlib.util.spec_from_file_location('durable_host',Path(__file__).with_name('model-fast-path.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class DurableReadPairTests(unittest.TestCase):
 def test_billing_app_read_keeps_one_interpretation_one_dispatch_and_original_receipt(self):
  tmp=TempStore();store=tmp.store();clock=Clock();graph=CapabilityGraph(PB,health_path=tmp.dir/'health.json',metrics_path=tmp.dir/'metrics.jsonl')
  runner=RecordedRunner(proposal(intent='billing.unpaid',domain_id='utility-billing'))
  backend=make_intent_dialogue_port(PB,surface='app',caller='owner',graph=graph,context_projection=lambda state,ctx:{},runner=runner)
  class Ports:
   def interpret_turn(self,text,state,ctx):return backend.interpret_turn(text,state,{**ctx,'messageProvenance':'server_verified'})
  msg=event('  etat de mes factures  ',surface='app',ref='pair-read',key='pair-app')
  try:
   asked=Coordinator(Ports(),store=store,clock=clock,lock_reader=open_lock).handle_admitted_event(msg,{'deferHandoff':True})
   self.assertEqual(asked['outcome'],'READY')
   revision,state=store.load(asked['conversationRef']);goal=state['goals'][asked['goalRef']];decision=goal['decision'];origin=goal['handoff']['originId']
   ctx={'caller':'owner','conversation_ref':asked['conversationRef'],'goal_ref':asked['goalRef'],
        'event_key':goal['handoff']['admittedEventKey'],'conversation_revision':revision,'_intent_dialogue_store':store}
   self.assertEqual(decision['continuum']['mode'],'durable')
   payload=json.loads((PB/'tests/fixtures/billing-screen-20261024/partial-read.json').read_text())['execution']['result']
   saved={};prepares=[];dispatches=[]
   def continuum(root,args):
    if args[0]=='prepare':
     prepares.append(args)
     return {'state':'terminal'} if saved else {'state':'ready','dispatch_allowed':True,'wire_step_id':'wire-step'}
    self.assertEqual(args[0],'settle');return {'state':'settled_read','mission_state':'completed','retry_authorized':False}
   def submit(cmd,**kwargs):
    self.assertIn('submit',cmd)
    params=json.loads(cmd[cmd.index('--params-json')+1]);dispatches.append(params)
    self.assertEqual(params['request'],msg['text'])
    self.assertEqual(params['decision'],decision)
    request_id=cmd[cmd.index('--request-id')+1]
    self.assertEqual(cmd[cmd.index('--method')+1],'capability_execute_readonly')
    # A distinct private connection rehydrates the admission; no trust object is serialized.
    with DialogueStore(tmp.path) as bridge_store:
     runtime=read_handoff_context(params['dialogueReadHandoff'],decision,bridge_store)
     result=graph.execute_decision(params['request'],params['decision'],read_only=True,runtime_context=runtime)
    saved.update(requestId=request_id,state='completed',result=result)
    return 0,dict(saved),''
   with patch.dict(os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}),patch.object(m,'_intent_dialogue_backend',return_value=SimpleNamespace(execute=lambda *a: (_ for _ in ()).throw(AssertionError('not the durable owner')))),patch.object(m,'_continuum_call',side_effect=continuum),patch.object(m,'_bridge_cli',return_value=Path('/fixture/bridge-cli')),patch.object(m,'_run_json',side_effect=submit),patch.object(m,'_bridge_status',side_effect=lambda *a,**k:dict(saved)),patch('subprocess.run',return_value=subprocess.CompletedProcess([],2,json.dumps(payload),'')) as provider:
    ports=m.FastPathPorts(PB,surface='claw_live',dialogue_surface='app',caller='owner',timeout=30)
    out=ports.execute(msg['text'],decision,origin,'DURABLE',ctx)
    self.assertEqual(out['execution_state'] if 'execution_state' in out else out['reason'],'partial')
    self.assertEqual(len(out['presentation']['rows']),4)
    self.assertIn('Total global non établi',out['text'])
    again=ports.execute(msg['text'],decision,origin,'DURABLE',ctx)
    self.assertEqual(again['presentation'],out['presentation'])
    self.assertEqual(len(dispatches),1);self.assertEqual(provider.call_count,1);self.assertEqual(runner.calls,1)
    self.assertEqual(prepares[0],prepares[1])
    for bad_ctx in ({**ctx,'_intent_dialogue_store':{}},{**ctx,'conversation_revision':revision+1}):
     denied=ports.execute(msg['text'],decision,origin,'DURABLE',bad_ctx)
     self.assertEqual(denied['reason'],'intent_read_handoff_unqualified')
    self.assertEqual(len(dispatches),1)
  finally:store.close();tmp.cleanup()

 def test_claw_helper_forwards_read_reference_and_frozen_text_to_graph(self):
  import base64
  spec=importlib.util.spec_from_file_location('read_claw_helper',Path(__file__).with_name('claw-capability.py'))
  helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
  decision={'version':2,'risk':'read'};reference={'conversationRef':'conv-fixture','goalRef':'goal-fixture','eventKey':'event-fixture','originId':'origin-fixture','revision':1}
  args=['claw-capability.py','execute-decision','  etat de mes factures  ','--decision-b64',base64.b64encode(json.dumps(decision).encode()).decode(),'--read-only','--dialogue-read-handoff',json.dumps(reference)]
  with patch.object(sys,'argv',args),patch.object(helper,'call',return_value=0) as called:
   self.assertEqual(helper.main(),0)
  forwarded=called.call_args.args[0]
  self.assertEqual(forwarded[1],'  etat de mes factures  ')
  self.assertIn('--read-only',forwarded)
  self.assertEqual(json.loads(forwarded[forwarded.index('--dialogue-read-handoff')+1]),reference)


if __name__=='__main__':unittest.main()
