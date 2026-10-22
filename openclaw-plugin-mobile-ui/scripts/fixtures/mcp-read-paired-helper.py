"""MOCK integration harness: real helper/private IPC/backend/Graph, zero external providers."""
import importlib.util,json,os,sys,subprocess,stat
from pathlib import Path
from unittest import mock
PB=Path(os.environ['MCP_PAIRED_PLAYBOOKS_ROOT']).resolve()
CORE=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(PB))
from skill_intelligence.capability_graph import CapabilityGraph
from skill_intelligence.intent_dialogue import make_intent_dialogue_port
from skill_intelligence.agent_runner import EngineeringAgentRunner
from skill_intelligence.model_governor import ModelGovernor
from tests.test_intent_dialogue import RecordedRunner
from tests.test_intent_interpreter import proposal,param

spec=importlib.util.spec_from_file_location('actual_fastpath',CORE/'installer/termux-lite/model-fast-path.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(os.environ['PAIR_ROOT']); audit=root/'audit.jsonl'
def record(row):
    with audit.open('a') as out:out.write(json.dumps(row)+'\n')
def build(ui_root,*,surface,caller,timeout):
    graph=CapabilityGraph(PB,health_path=root/'health.json',metrics_path=root/'metrics.jsonl')
    if os.environ.get('PAIR_DATA_DENIAL')=='1':
        runner=EngineeringAgentRunner(ModelGovernor(root/'models.db'),selection_snapshot=mock.Mock(side_effect=AssertionError('metadata before DATA')))
    else:
        def scripted(request):
            record({'kind':'interpretation','mode':'MOCK','conversation_ref':request['conversation_ref'],
                    'original_exact':request['message']['text'],'provenance':request['message']['provenance']})
            ref=request['message']['ref']
            if 'démarre' in request['message']['text']:
                return proposal('project.phase.set_status',parameters=[param('project_query','huwaei',ref=ref),param('state','started','démarre',ref=ref)])
            return proposal(parameters=[param('offer_query','huwaei',ref=ref)])
        runner=RecordedRunner(scripted)
    with mock.patch('subprocess.run',side_effect=AssertionError('Graph write guard must precede every executor')):
        denied=graph._execute_core('synthetic read-only boundary probe',read_only=True,resolved={
            'selected':{'risk':'write','deterministic':True,'authorized':True,'target':'pulse'},
            'confirmation_required':False,'sufficiency':{'state':'sufficient'}})
    assert denied['execution']=={'state':'blocked','reason':'read_only_policy'}
    record({'kind':'graph_write_guard','qualification':'SYNTHETIC_BOUNDARY_ONLY','state':'blocked','reason':'read_only_policy','executor_calls':0})
    def command(argv,**kwargs):
        record({'kind':'executor','argv':argv,'mode':'MOCK'})
        assert 'offer' in argv and any(str(value).endswith('pulse-cli.mjs') for value in argv)
        return subprocess.CompletedProcess(argv,0,json.dumps({'ok':True,'items':[{'label':'Fixture result'}]}),'')
    graph.resolve=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('lexical resolver forbidden'))
    subprocess.run=command
    return make_intent_dialogue_port(PB,surface=surface,caller=caller,timeout=timeout,graph=graph,runner=runner,
                                     prepare_command=lambda *args,**kwargs:None)
m._intent_dialogue_backend=build
raise SystemExit(m.main())
