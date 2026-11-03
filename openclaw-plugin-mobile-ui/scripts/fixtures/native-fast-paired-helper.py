#!/usr/bin/env python3
"""C18 MOCK_ONLY: real private IPC/owners; no model, context authority or HTTP."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest import mock
root=Path(os.environ['CLAW_UI_PLAYBOOKS_ROOT']).resolve();sys.path.insert(0,str(root))
from skill_intelligence import intent_dialogue
from skill_intelligence.capability_graph import CapabilityGraph
from skill_intelligence.dialogue.native_fast import _bind_native_read_precondition
from tests.test_intent_dialogue import RecordedRunner
from tests.test_intent_interpreter import proposal,param
log=Path(os.environ['C18_LOG'])
def record(value):
    with log.open('a') as out:out.write(json.dumps(value)+'\n')
def result(request):
    record({'kind':'MOCK_INTERPRETATION','text':request['message']['text'],'conversation':request['conversation_ref']})
    return proposal('project.snapshot',parameters=[param('project_query','20495',ref=request['message']['ref'])])
original_factory=intent_dialogue.make_intent_dialogue_port
def factory(ui_root,**kwargs):
    kwargs.update(runner=RecordedRunner(result),context_projection=lambda *args:{})
    return original_factory(ui_root,**kwargs)
intent_dialogue.make_intent_dialogue_port=factory
original_execute=CapabilityGraph.execute_decision
def execute(graph,*args,**kwargs):
    assert kwargs['read_only'] is True
    def read(argv,**opts):
        assert '--prepared-command-stdin' not in argv
        assert 'pulse-cli.mjs' in argv[1], repr(argv)
        record({'kind':'MOCK_NATIVE_READ','read_only':True})
        return SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'project':{'id':'20495'},'message':'MOCK project read'}),stderr='')
    with mock.patch('subprocess.run',side_effect=read),mock.patch.object(graph,'_execute_with_learning',side_effect=graph._execute_core):
        return original_execute(graph,*args,**kwargs)
CapabilityGraph.execute_decision=execute
CapabilityGraph.resolve=lambda *a,**k:(_ for _ in ()).throw(AssertionError('no second interpretation'))
helper=Path(os.environ['C18_REAL_HELPER']);spec=importlib.util.spec_from_file_location('c18_actual',helper)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
# Legacy C16/C18 tests deliberately MOCK_ONLY source admission. C17's actual
# Contacts/instruction/DATA owners are exercised by test_native_room_context.
module._native_context_for_event=lambda *a,**k:None

# This legacy fixture replaces the concrete C17 owner with a MOCK scope callback.
def scoped_fixture(*,native_event,store,goal_ref):
    if os.environ.get('C18_SCOPE_MODE')=='absent':raise ValueError('MOCK absent scope')
    revision,state=store.load(native_event.conversation_ref)
    def revalidate(**kw):
        record({'kind':'MOCK_SCOPE_REVALIDATION','conversation':kw['native_event'].conversation_ref})
        if os.environ.get('C18_SCOPE_MODE')=='revoked':raise ValueError('MOCK revoked')
        if os.environ.get('C18_SCOPE_MODE')=='boolean':return True
    return _bind_native_read_precondition(native_event,goal_ref=goal_ref,conversation_revision=revision,
        decision=state['goals'][goal_ref]['decision'],require_current_scope=revalidate)
module._NATIVE_FAST_READ_SCOPE_OWNER=scoped_fixture
raise SystemExit(module.main())
