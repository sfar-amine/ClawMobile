"""MOCK integration harness: real helper/private IPC/backend/Graph, zero external providers."""
import importlib.util,json,os,sys,subprocess,stat,sqlite3
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
from skill_intelligence import interpretation_context
from tools import request_context

spec=importlib.util.spec_from_file_location('actual_fastpath',CORE/'installer/termux-lite/model-fast-path.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(os.environ['PAIR_ROOT']); audit=root/'audit.jsonl'
def record(row):
    with audit.open('a') as out:out.write(json.dumps(row)+'\n')
# Synthetic private home; no environment HOME or public input path is used.
home=root/'synthetic-home';workspace=home/'.openclaw/workspace'
if not workspace.exists():
    workspace.mkdir(parents=True)
    for key,fixture in [('SOUL.md','SOUL.md'),('AGENTS.md','AGENTS.md'),('context/OPERATING_RULES.md','OPERATING_RULES.md')]:
        target=workspace/key;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes((PB/'tests/fixtures/context-core-v2'/fixture).read_bytes())
    rules=workspace/'context/rules';rules.mkdir()
    for name in ('memory','routes'):(rules/(name+'.md')).write_text('Synthetic scoped rule '+name)
    (rules/'manifest.json').write_text(json.dumps({'version':1,'modules':{
        name:{'path':'context/rules/'+name+'.md','pattern':'(?!)'} for name in ('memory','routes')}}))
    (workspace/'context/HYBRID_CONTEXT.md').write_bytes((PB/'tests/fixtures/context-coverage/producer-projection.md').read_bytes())
    db=home/'.openclaw/context-sync/memory.db';db.parent.mkdir(parents=True)
    with sqlite3.connect(db) as c:
        c.execute('CREATE TABLE events(id TEXT,revision INTEGER,surface TEXT,kind TEXT,text TEXT,created_at TEXT,supersedes TEXT)')
        c.executemany('INSERT INTO events VALUES(?,?,?,?,?,?,?)',[
            ('constraint',3,'app','constraint','Synthetic full owner constraint','2026-10-22T00:00:00Z',None),
            ('decision',4,'app','decision','Synthetic full owner decision','2026-10-22T00:00:00Z',None),
            ('thread',2,'app','open_thread','Do not import OTHER_THREAD_PRIVATE_GOAL','2026-10-22T00:00:00Z',None)])
original_snapshot=request_context.snapshot;original_owner=interpretation_context._owner
original_mint=interpretation_context._admit_owner_context_channel
def snapshot(*args,**kwargs):
    assert args[0]==home;record({'kind':'snapshot'})
    return original_snapshot(*args,**kwargs)
def owner(owner_root):
    assert owner_root==CORE/'installer/termux-lite';record({'kind':'memory_owner'})
    return original_owner(owner_root)
def mint(**kwargs):
    assert kwargs['home']==home and kwargs['core_owner_root']==CORE/'installer/termux-lite'
    record({'kind':'mint','request_id':kwargs['request_id']})
    return original_mint(**kwargs)
request_context.snapshot=snapshot;interpretation_context._owner=owner
interpretation_context._admit_owner_context_channel=mint
def build(ui_root,*,surface,caller,timeout):
    graph=CapabilityGraph(PB,health_path=root/'health.json',metrics_path=root/'metrics.jsonl')
    if os.environ.get('PAIR_DATA_DENIAL')=='1':
        runner=EngineeringAgentRunner(ModelGovernor(root/'models.db'),selection_snapshot=mock.Mock(side_effect=AssertionError('metadata before DATA')))
    else:
        def scripted(request):
            encoded=json.dumps(request)
            assert 'Synthetic full owner constraint' in encoded and 'Synthetic full owner decision' in encoded
            assert 'OTHER_THREAD_PRIVATE_GOAL' not in encoded
            assert request['input_provenance']['shared']=='server_verified'
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
                                     context_read_evidence=m._INTENT_CONTEXT_READ_EVIDENCE,prepare_command=lambda *args,**kwargs:None)
m._intent_dialogue_backend=build
with mock.patch.object(Path,'home',return_value=home):
    raise SystemExit(m.main())
