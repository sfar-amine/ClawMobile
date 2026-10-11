// 38 E3 — before_tool_call boundary and atomic agent refusal of clawmobile_capability.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {agentCapabilityHook:hook,AGENT_CAPABILITY_REFUSAL}=require('../dist/capabilityAgentGuard.js');
const protocol=fs.readFileSync(path.join(__dirname,'../fixtures/protocol/openclaw-2026.9.6/e3-hook-excerpts.d.ts'),'utf8');
assert.match(protocol,/requester\?: PluginHookToolRequesterContext/);assert.match(protocol,/readonly senderIsOwner\?: boolean/);assert.match(protocol,/block\?: boolean/);assert.match(protocol,/params\?: Record<string, unknown>/);
let checks=4;
const blocked={block:true,blockReason:AGENT_CAPABILITY_REFUSAL};
assert.equal(AGENT_CAPABILITY_REFUSAL,'capability_first_required');checks++;
// caller comes from the host turn identity, never from the model.
for(const owner of [true,false]){
  const out=hook({toolName:'clawmobile_capability',params:{request:'recharge orange 5 dt',caller:'owner'}},{requester:{senderIsOwner:owner}});
  assert.equal(out.params.caller,owner?'owner':'other');assert.equal(out.params.request,'recharge orange 5 dt');checks+=2;
}
// No host identity: the model caller is dropped (P1 factory context stays the authority).
for(const context of [{},{requester:{}},{requester:{senderIsOwner:'true'}},{requester:Object.create({senderIsOwner:true})}]){
  const out=hook({toolName:'clawmobile_capability',params:{request:'lecture',caller:'owner'}},context);
  assert.equal('caller' in out.params,false);checks++;
}
// Malformed model arguments fail closed.
for(const params of [undefined,null,[],42,{request:''},{request:'   '},{request:42},{request:{text:'x'}},{request:'x'.repeat(12001)},{request:'ok',nested:{a:1}}]){
  assert.deepEqual(hook({toolName:'clawmobile_capability',params},{requester:{senderIsOwner:true}}),blocked);checks++;
}
let getterReads=0;const withGetter={request:'lecture'};
Object.defineProperty(withGetter,'caller',{enumerable:true,get(){getterReads++;throw Error('accessor');}});
assert.deepEqual(hook({toolName:'clawmobile_capability',params:withGetter},{requester:{senderIsOwner:true}}),blocked);assert.equal(getterReads,0);checks+=2;
const trapped=new Proxy({request:'lecture'},{getOwnPropertyDescriptor(){throw Error('inspection');}});
assert.deepEqual(hook({toolName:'clawmobile_capability',params:trapped},{requester:{senderIsOwner:true}}),blocked);checks++;
// Other tools are untouched; snapshot is independent of later mutation.
assert.equal(hook({toolName:'android_health',params:{}},{}),undefined);checks++;
const live={request:'lecture'};const snap=hook({toolName:'clawmobile_capability',params:live},{requester:{senderIsOwner:false}});
live.request='changed';assert.equal(snap.params.request,'lecture');checks++;

// Runtime registration: one before_tool_call that keeps providerFallback bookkeeping and applies E3.
const hooks=[];require('../dist/index.js').register({on(name,fn){hooks.push([name,fn]);},registerTool(){},logger:{}});
const before=hooks.filter(x=>x[0]==='before_tool_call');assert.equal(before.length,1);checks++;
const out=before[0][1]({toolName:'clawmobile_capability',params:{request:'mon solde orange',caller:'owner'}},{requester:{senderIsOwner:false},sessionKey:'agent:main:whatsapp:direct:x'});
assert.equal(out.params.caller,'other');checks++;
assert.equal(before[0][1]({toolName:'read',params:{path:'x'}},{}),undefined);checks++;

// Atomic refusal inside the tool: execute always goes through `agent-execute`, never `execute`.
(async()=>{
  const {clawmobile_capability}=require('../dist/capabilityTool.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'e3-tool-'));const log=path.join(root,'argv.log');const helper=path.join(root,'helper.py');
  fs.writeFileSync(helper,[
    'import json,sys',
    `open(${JSON.stringify(log)},'a').write(json.dumps(sys.argv[1:])+'\\n')`,
    'cmd=sys.argv[1]; text=sys.argv[2]',
    "if cmd=='agent-execute' and 'recharge' in text: print(json.dumps({'capability':'telecom.orange.consultation','agent_policy':{'allowed':False,'risk':'read','operator_targets':['maxit-tunisie']},'execution':{'state':'blocked','reason':'capability_first_required','executed':False}}))",
    "else: print(json.dumps({'execution':{'state':'completed'},'selected':{'risk':'read'}}))",''].join('\n'));
  const refused=await clawmobile_capability({request:'recharge 5 dt sur ma ligne orange',execute:true},{helperPath:helper,turnContext:{senderIsOwner:true}});
  assert.equal(refused.status,'error');assert.equal(refused.reason,'capability_first_required');assert.equal(refused.executed,false);checks+=3;
  const read=await clawmobile_capability({request:'mes rendez-vous',execute:true},{helperPath:helper,turnContext:{senderIsOwner:true}});
  assert.equal(read.status,'ok');checks++;
  await clawmobile_capability({request:'mes rendez-vous',execute:false},{helperPath:helper,turnContext:{senderIsOwner:true}});
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c[0]),['agent-execute','agent-execute','resolve']);checks++;
  assert.equal(calls.some(c=>c[0]==='execute'),false);checks++;
  // A forged caller is still refused by P1 before any helper call.
  const forged=await clawmobile_capability({request:'mon solde orange',caller:'owner'},{helperPath:helper,turnContext:{senderIsOwner:false}});
  assert.equal(forged.reason,'caller_not_admitted');assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,3);checks+=2;
  fs.rmSync(root,{recursive:true,force:true});
  console.log(`E3 agent guard: ${checks} checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
