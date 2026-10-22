#!/usr/bin/env python3
"""C16 MOCK_ONLY wrapper around the actual core helper and actual PB owners.

Only fixture provider output, native preparation receipt and final HTTP process
port are injected. No network, account, S24 or business effect is possible.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
from types import SimpleNamespace
from unittest import mock

root=Path(os.environ['CLAW_UI_PLAYBOOKS_ROOT']).resolve()
sys.path.insert(0,str(root))
from skill_intelligence import intent_dialogue
from skill_intelligence.capability_graph import CapabilityGraph
from skill_intelligence.dialogue.confirmation import admit_project_preparation,prepare_project_command
from tests.test_intent_dialogue import RecordedRunner
from tests.test_intent_interpreter import proposal,param

fixture=json.loads(Path(os.environ['C16_FIXTURE_RESULT']).read_text())
assert fixture['qualification']=='MOCK_ONLY'
log=Path(os.environ['C16_PAIRED_LOG'])
def record(value):
    with log.open('a') as out:out.write(json.dumps(value,ensure_ascii=False)+'\n')
def result(request):
    record({'kind':'interpretation','conversation':request['conversation_ref'],
        'text':request['message']['text'],'provenance':request['message']['provenance']})
    mode=os.environ.get('C16_RESULT_MODE')
    if mode=='invalid':return proposal('project.phase.set_status',route='forged')
    if mode=='unsupported':return proposal(None,domain_id=None,status='unsupported')
    if mode=='ambiguous':return proposal(None,domain_id=None,status='ambiguous',question_proposal='Quel projet et quelle phase souhaites-tu préciser ?')
    pending=request['pending_confirmation']
    if pending:
        return proposal('project.phase.set_status',message_kind='confirmation_answer',
            referenced_goal=request['active_goal']['goalRef'],referenced_confirmation=pending['ref'],confirmation_response='accept')
    return proposal('project.phase.set_status',parameters=[
        param('project_query','20495',ref=request['message']['ref']),param('phase','Build',ref=request['message']['ref']),
        param('state','started','démarre',ref=request['message']['ref'])])
def prepare(resolution,**bindings):
    return admit_project_preparation(resolution['decision'],fixture['prepared'],
        requester=resolution['caller'],policy_revision=resolution['capability_revision'],**bindings)
old_factory=intent_dialogue.make_intent_dialogue_port
def factory(ui_root,**kwargs):
    kwargs.update(runner=RecordedRunner(result),context_projection=lambda *args:{})
    if os.environ.get('C16_RESULT_MODE')!='unqualified':kwargs['prepare_command']=prepare
    else:
        def real_unqualified(resolution,**bindings):
            def cli(argv,**opts):
                return subprocess.run([argv[0],'--import',str(root/'billing/direct-runtime/test-support/register-openclaw-stub.mjs'),*argv[1:]],**opts)
            return prepare_project_command(root,resolution,run=cli,**bindings)
        kwargs['prepare_command']=real_unqualified
    if os.environ.get('C16_RESULT_MODE')=='data_closed':
        from skill_intelligence.agent_runner import EngineeringAgentRunner
        from skill_intelligence.model_governor import ModelGovernor
        kwargs['runner']=EngineeringAgentRunner(ModelGovernor(Path.home()/'.openclaw/autonomous-engineering/models.db'),
            selection_snapshot=mock.Mock(side_effect=AssertionError('metadata before DATA')))

    return old_factory(ui_root,**kwargs)
intent_dialogue.make_intent_dialogue_port=factory
original=CapabilityGraph.execute_decision
original_core=CapabilityGraph._execute_core
def recorded_execute(graph,*args,**kwargs):
    def cli(argv,**opts):
        assert (root/argv[1]).resolve()==root/'billing/direct-runtime/pulse-cli.mjs', repr(argv)
        assert '--prepared-command-stdin' in argv
        assert json.loads(opts['input'])==fixture['prepared']['prepared_command']
        if os.environ.get('C16_RESULT_MODE')=='pre_submit_refusal':
            record({'kind':'MOCK_NATIVE_REFUSAL','reason':'pulse_native_contract_changed'})
            return SimpleNamespace(returncode=0,stdout=json.dumps({'ok':False,
                'status':'confirmation_invalidated','reason_code':'pulse_native_contract_changed',
                'write_count':0,'writes':[]}),stderr='')
        record({'kind':'MOCK_NATIVE_WRITE','read_only':kwargs.get('read_only'),
            'conversation':kwargs['runtime_context']['conversation_ref']})
        return SimpleNamespace(returncode=0,stdout=json.dumps(fixture['execution']['result']),stderr='')
    with mock.patch('subprocess.run',side_effect=cli),mock.patch.object(graph,'_execute_with_learning',side_effect=graph._execute_core):
        return original(graph,*args,**kwargs)
CapabilityGraph.execute_decision=recorded_execute
CapabilityGraph.resolve=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('lexical resolver forbidden'))
# Actual inherited private stream validation, CLI phases, Coordinator, Store,
# opaque grants, Continuum and Graph guards are unchanged.
helper=Path(os.environ['C16_REAL_HELPER']).resolve()
spec=importlib.util.spec_from_file_location('c16_actual_core_helper',helper)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
raise SystemExit(module.main())
