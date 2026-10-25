const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const guard = require('../dist/capabilityAgentGuard.js');
const tools = require('../dist/typedCapabilityTools.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-tools-'));
const fixture = path.join(__dirname, '../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json');
const ctx = {senderIsOwner:true, agentId:'main', sessionKey:'agent:main:companion-chat-typed', sessionId:'session-1',
  assertInvocationCurrent() { if (ctx.revoked) throw Error('revoked'); }};
const value = JSON.parse(fs.readFileSync(fixture, 'utf8'));
function bind(name, args, callId, overrides={}) {
  return guard.agentCapabilityHook({toolName:name,params:args,toolCallId:callId},
    {requester:{senderIsOwner:true},agentId:'main',runId:'user-run-1',sessionKey:ctx.sessionKey,sessionId:ctx.sessionId,...overrides});
}
async function main() {
  const views = path.join(root,'.openclaw/capability-views');fs.mkdirSync(views,{recursive:true});
  fs.copyFileSync(fixture,path.join(views,'agent-tools.json'));
  assert.equal(tools.readTypedToolCatalogue(root).length,12);
  assert.equal(tools.createTypedCapabilityTools({...ctx,senderIsOwner:false},{home:root}),null);
  assert.equal(tools.createTypedCapabilityTools({...ctx,agentId:'contacts'},{home:root}),null);
  const helper=path.join(root,'helper.py');
  fs.writeFileSync(helper,"import sys,json\np=json.load(sys.stdin)\nprint(json.dumps({'state':'COMPLETED','received':p}))\n");
  const descriptors=tools.createTypedCapabilityTools(ctx,{home:root,helperPath:helper});
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../openclaw.plugin.json'),'utf8'));
  for(const tool of descriptors)assert(manifest.contracts.tools.includes(tool.name));
  const orange=descriptors.find(t=>t.name==='samantha_maxit_tunisie');
  const args={action:'telecom.balance',params:{}};
  assert.equal((await orange.execute('missing-hook',args)).isError,true);
  assert.equal(bind(orange.name,args,'one').block,undefined);
  const result=JSON.parse((await orange.execute('one',args)).content[0].text);
  assert.equal(result.state,'COMPLETED');
  assert.equal(result.received.host.userRunId,'user-run-1');
  assert.equal(result.received.host.owner,true);
  assert.deepEqual(result.received.command,{operation:'call',domain:'maxit-tunisie',action:'telecom.balance',params:{}});
  assert.equal((await orange.execute('one',args)).isError,true,'one-shot admission cannot be replayed');
  assert.equal(bind(orange.name,args,'foreign',{requester:{senderIsOwner:false}}).block,true);
  assert.equal(bind(orange.name,args,'contact',{agentId:'contacts'}).block,true);
  assert.equal(bind(orange.name,args,'no-run',{runId:undefined}).block,true);
  bind(orange.name,args,'session-change');
  assert.throws(()=>guard.consumeTypedInvocation('session-change',orange.name,args,{...ctx,sessionKey:'other'}));
  bind(orange.name,args,'mutated');
  assert.equal((await orange.execute('mutated',{action:'telecom.usage',params:{}})).isError,true);
  bind(orange.name,args,'collision');
  assert.equal(bind(orange.name,args,'collision').block,true);
  assert.equal((await orange.execute('collision',args)).isError,true);
  bind(orange.name,args,'revoked');ctx.revoked=true;
  assert.equal((await orange.execute('revoked',args)).isError,true);ctx.revoked=false;

  const catalogue=descriptors.find(t=>t.name==='samantha_catalogue');
  bind(catalogue.name,{query:'factures'},'catalogue');
  const discovered=JSON.parse((await catalogue.execute('catalogue',{query:'factures'})).content[0].text);
  assert.equal(discovered.state,'discovery');assert(discovered.capabilities.length>0);
  assert(discovered.capabilities.length<=8);

  const app=descriptors.find(t=>t.name==='samantha_app');
  const query={action:'samantha.app.nightly_acceptance',params:{}};
  bind(app.name,query,'health');
  const health=JSON.parse((await app.execute('health',query)).content[0].text);
  assert.deepEqual(health.received.command,{operation:'call',domain:'app',action:'samantha.app.nightly_acceptance',params:{}});
  bind(app.name,query,'health-revoked');ctx.revoked=true;
  assert.equal((await app.execute('health-revoked',query)).isError,true);ctx.revoked=false;
  const bridgeHelper=path.join(root,'bridge.py');
  fs.writeFileSync(bridgeHelper,"import sys,json\np=json.load(sys.stdin)\nprint(json.dumps({'mode':sys.argv[1],'selection':p,'argv':sys.argv[2:]}))\n");
  const {capabilityBridge}=require('../dist/companion/capabilityBridge');
  const selection={domain:'maxit-tunisie',action:'telecom.balance',params:{}};
  for(const execute of [false,true]){
    const result=await capabilityBridge('Ce texte ne doit pas être résolu',{typedSelection:selection,execute,
      readOnly:true,requestId:'mcp-fixture-one',caller:'owner',surface:'external_mcp',helperPath:bridgeHelper});
    assert.equal(result.success,true);assert.equal(result.mode,execute?'typed-execute':'typed-resolve');
    assert.deepEqual(result.selection,selection);assert(!result.argv.includes('--decision-b64'));
    assert(result.argv.includes('--selection-stdin'));
  }
  console.log('typed-capability-tools: PASS (pinned canonical projection, exact host invocation, owner isolation, no replay, canonical app invocation)');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
