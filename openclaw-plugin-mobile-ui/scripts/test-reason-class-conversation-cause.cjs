const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'reason-class-cause-'));process.env.OPENCLAW_STATE_DIR=root;
const registry=path.join(root,'clawmobile-companion/runs.json');fs.mkdirSync(path.dirname(registry),{recursive:true});
fs.writeFileSync(registry,JSON.stringify({version:1,runs:[],paymentRequests:[],ownerConfirmations:[],archivedSessionIds:[],runDeletions:[]}));
// SAM-MIG V2.2: stand-in of `model-fast-path.py --dialogue` (turn, then deferred hand-off); reason_class travels in the reply metadata.
const helper=path.join(root,'runner.py');
fs.writeFileSync(helper,`import json,sys\nd={'version':2,'type':'EXECUTE','capability':'device.status','intent':'device.status','target':'device','risk':'read','confirmationRequired':False,'parameters':{}}\nm=sys.argv[sys.argv.index('--dialogue')+1]\nif m=='turn': print(json.dumps({'outcome':'READY','handled':True,'goalRef':'goal-0000000000000000beef','pendingHandoff':{'goalRef':'goal-0000000000000000beef','klass':'FAST'},'decision':d}))\nelse: print(json.dumps({'outcome':'FAILED','text':'Lecture indisponible.','handled':True,'decision':d,'metadata':{'reason_class':'transport_timeout'}}))\n`);
process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
const client=require('../dist/companion/openclawAgentClient');client.callOpenClawGateway=async(method)=>{if(method==='sessions.list')return {sessions:[]};throw Error('unexpected gateway call '+method)};
const runs=require('../dist/companion/runs'),{submitIntent}=require('../dist/companion/intent'),metadata=require('../dist/companion/conversationMetadata');
(async()=>{
 assert.equal(runs.publicReasonClass('transport_timeout'),'transport_timeout');
 for(const bad of ['TransportTimeout','transport-timeout','a'.repeat(97),'Bearer private',''])assert.equal(runs.publicReasonClass(bad),undefined);
 const submitted=await submitIntent('lis l’état de l’appareil','reason-class',[],{clientRunId:'reason-class-fixture'});
 assert.equal(submitted.state,'failed');assert.equal(submitted.reasonClass,'transport_timeout');
 const status=await runs.getRunStatus(submitted.runId);assert.equal(status.reasonClass,'transport_timeout');
 const saved=JSON.parse(fs.readFileSync(registry,'utf8')).runs.find(x=>x.runId===submitted.runId);assert.equal(saved.reasonClass,'transport_timeout');
 const duplicate=await submitIntent('lis l’état de l’appareil','reason-class',[],{clientRunId:'reason-class-fixture'});assert.equal(duplicate.reasonClass,'transport_timeout');
 const unavailable=await metadata.readConversationMetadata('reason-class');
 assert.equal(unavailable.state,'degraded');assert.equal(unavailable.readOnly,true);
 assert.deepEqual(unavailable.cause,{code:'conversation_gateway_session_unavailable',messages:{fr:'Cette conversation reste consultable, mais sa session Gateway n’est plus disponible. Elle est en lecture seule.',en:'This conversation remains readable, but its Gateway session is no longer available. It is read-only.'}});
 assert(unavailable.issues.includes(unavailable.cause.code));assert.equal(unavailable.alert,undefined);assert.equal(unavailable.notification,undefined);
 const modulePath=path.resolve(__dirname,'../../installer/termux-lite/model-fast-path.py');
 const py=cp.execFileSync('python3',['-c',`import importlib.util,pathlib\np=pathlib.Path(${JSON.stringify(modulePath)})\ns=importlib.util.spec_from_file_location('m',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nassert m._public_reason_class({'reason_class':'urlerror_oserror_enetunreach'})=='urlerror_oserror_enetunreach'\nassert m._public_reason_class({'reason_class':'private detail'}) is None\nprint('ok')`],{encoding:'utf8'}).trim();assert.equal(py,'ok');
 console.log('F52 reasonClass runner -> registry -> receipt API and localized degraded/read-only conversation cause: 14/14');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
