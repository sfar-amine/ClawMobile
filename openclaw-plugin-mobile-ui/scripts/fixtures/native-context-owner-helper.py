#!/usr/bin/env python3
"""C17 real private stdin + real Contacts/DATA/Store owners, provider MOCK_ONLY."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from unittest import mock
root=Path(os.environ['C17_PLAYBOOKS_ROOT']).resolve();sys.path.insert(0,str(root))
from tests.test_native_room_context import NativeContextTests
from tests.test_intent_dialogue import RecordedRunner
from tests.test_intent_interpreter import proposal,param
from skill_intelligence import intent_dialogue
from skill_intelligence.interpretation_data import FREE_PROFESSIONAL_MODEL,admit_projection

case=NativeContextTests('runTest');case.setUp()
class GovernedMock(RecordedRunner):
    def request_interpretation_governed(self,generation,prompt,**kwargs):
        access=kwargs['access_by_model'](FREE_PROFESSIONAL_MODEL)
        assert admit_projection(prompt,FREE_PROFESSIONAL_MODEL,
            source=kwargs['source'],access=access,now=case.now)['admitted']
        assert kwargs['_revalidate_current'](prompt=prompt,model=FREE_PROFESSIONAL_MODEL,
            source=kwargs['source'],access=access)
        return super().request_interpretation_governed(generation,prompt,**kwargs)
runner=GovernedMock(lambda request:proposal('offer.snapshot',
    parameters=[param('offer_query','20447',ref=request['message']['ref'])]))
runner.governor=case.runner.governor;runner.command_runner=case.runner.command_runner
runner.policy=case.runner.policy
original=intent_dialogue.make_intent_dialogue_port
def factory(ui_root,**kwargs):
    kwargs['runner']=runner
    return original(ui_root,**kwargs)
path=Path(__file__).resolve().parents[3]/'installer/termux-lite/model-fast-path.py'
spec=importlib.util.spec_from_file_location('c17_actual_private_helper',path)
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
# No admission/projection/backend scope seam is mocked here.
with mock.patch.object(intent_dialogue,'make_intent_dialogue_port',side_effect=factory), \
     mock.patch('skill_intelligence.interpretation_access.qualified_pin_owner',return_value=True):
    try:code=module.main()
    finally:
        case.doCleanups()
raise SystemExit(code)
