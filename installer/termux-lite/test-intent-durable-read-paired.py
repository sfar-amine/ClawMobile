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
 def test_owner_app_read_is_no_longer_interpreted_before_the_brain(self):
  # ADR 02/11 « le cerveau partout », step 3: the owner's app turn goes to the brain; this port never starts the
  # interpreter for it (the former « one interpretation, one durable dispatch » owner-app case is retired with it).
  with patch.dict(os.environ,{'SAMANTHA_INTENT_INTERPRETER':'1'}),patch.object(m,'_intent_dialogue_backend',side_effect=AssertionError('owner app interpreter')):
   ports=m.FastPathPorts(PB,surface='claw_live',dialogue_surface='app',caller='owner',timeout=30)
   self.assertFalse(hasattr(ports,'interpret_turn'))
   self.assertFalse(ports._semantic_enabled)

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
