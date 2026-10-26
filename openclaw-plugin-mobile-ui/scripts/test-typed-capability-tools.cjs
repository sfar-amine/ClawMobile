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
  const mcp=require('../dist/companion/mcpBridge');
  const previousFlag=process.env.SAMANTHA_BRAIN_ONLY;
  process.env.SAMANTHA_BRAIN_ONLY='1';
  const envelope={kind:'samantha.typed-selection.v1',selection};
  assert.deepEqual(mcp.typedMcpSelection({decision:envelope}),selection);
  assert.deepEqual(mcp.typedMcpSelection({typed:selection}),selection);
  for(const conflict of [{typed:selection},{target_hint:'owner'},{client_context:{}},{service_scope:{}}])
    assert.throws(()=>mcp.typedMcpSelection({decision:envelope,...conflict}),/typed_input_conflict/);
  for(const bad of [{...envelope,owner:true},{...envelope,selection:{...selection,owner:true}},
    {...envelope,selection:{...selection,params:null}}])
    assert.throws(()=>mcp.typedMcpSelection({decision:bad}),/typed_input/);
  process.env.CLAW_CAPABILITY_HELPER=bridgeHelper;
  const preview=await mcp.handleMcpRelayRequest({requestId:'mcp-typed-preview',clientId:'typed-test',
    profile:'chat-owner-shadow',tool:'claw_resolve',arguments:{request:'Ce texte ne doit pas être résolu',decision:envelope}});
  assert.equal(preview.state,'resolved');assert.equal(preview.result.mode,'typed-resolve');
  assert.deepEqual(preview.result.selection,selection);
  delete process.env.CLAW_CAPABILITY_HELPER;
  process.env.SAMANTHA_BRAIN_ONLY='0';
  assert.throws(()=>mcp.typedMcpSelection({decision:envelope}),/typed_path_not_active/);
  if(previousFlag===undefined)delete process.env.SAMANTHA_BRAIN_ONLY;else process.env.SAMANTHA_BRAIN_ONLY=previousFlag;
  // A Pulse contact projects only its already granted room, with a current SDK proof and fresh People reads.
  process.env.SAMANTHA_BRAIN_ONLY='1';
  const contacts=require('../dist/companion/whatsappAllowlist');
  const savedRead=contacts.allowlistRead;
  const contactNumber='+21610000003',contactId='wa-'+require('crypto').createHash('sha256').update(contactNumber).digest('hex').slice(0,16);
  let reads=0,revoked=false;
  contacts.allowlistRead=async(kind,id)=>{reads++;return {success:true,contactId:id,e164:contactNumber,owner:false,state:revoked?'suspended':'active',rooms:['pulse'],expiresAt:null};};
  const pulseCtx={senderIsOwner:false,agentId:'contacts-pulse',sessionKey:'agent:contacts-pulse:whatsapp:direct:'+contactNumber,
    sessionId:'scoped-session',messageChannel:'whatsapp',assertInvocationCurrent(){if(pulseCtx.stale)throw Error('stale');}};
  const pulseTools=tools.createTypedCapabilityTools(pulseCtx,{home:root,helperPath:helper});
  assert.deepEqual(pulseTools.map(t=>t.name),['samantha_pulse']);
  assert(!JSON.stringify(pulseTools[0].parameters).includes('certificate.rotate'));
  assert(!JSON.stringify(pulseTools[0].parameters).includes('leave.request'));
  const pulseArgs={action:'project.phases',params:{project_id:'20495'}};
  const bindPulse=(args,callId,changes={})=>guard.agentCapabilityHook({toolName:'samantha_pulse',params:args,toolCallId:callId},
    {requester:{senderIsOwner:false},agentId:'contacts-pulse',runId:'native-user-run',sessionKey:pulseCtx.sessionKey,sessionId:pulseCtx.sessionId,...changes});
  assert.equal(bindPulse(pulseArgs,'pulse-one').block,undefined);
  const pulseResult=JSON.parse((await pulseTools[0].execute('pulse-one',pulseArgs)).content[0].text);
  assert.equal(pulseResult.received.host.owner,false);
  assert.equal(pulseResult.received.host.actor,undefined,'no serializable authority actor is accepted');
  assert.equal(pulseResult.received.host.nativePulse.contact_id,contactId);
  assert.equal(pulseResult.received.host.conversationKey,pulseResult.received.host.nativePulse.conversation_key);
  assert.match(pulseResult.received.host.nativePulse.event_ref,/^typed-pulse:[a-f0-9]{64}$/);
  assert(reads>=2,'native authority is refreshed before effect');
  assert.equal((await pulseTools[0].execute('pulse-one',pulseArgs)).isError,true,'host admission is one shot');
  for(const changes of [{agentId:'main'},{agentId:'contacts'},{sessionKey:pulseCtx.sessionKey.replace('contacts-pulse','contacts-projet')},{requester:{senderIsOwner:true}}])
    assert.equal(bindPulse(pulseArgs,'pulse-foreign-'+JSON.stringify(changes).length,changes).block,true);
  assert.equal(guard.agentCapabilityHook({toolName:'samantha_app',params:pulseArgs,toolCallId:'pulse-app'},
    {requester:{senderIsOwner:false},agentId:'contacts-pulse',runId:'native-user-run',sessionKey:pulseCtx.sessionKey}).block,true);
  revoked=true;bindPulse(pulseArgs,'pulse-revoked');
  assert.equal((await pulseTools[0].execute('pulse-revoked',pulseArgs)).isError,true,'People revocation refuses before helper effect');revoked=false;
  pulseCtx.stale=true;bindPulse(pulseArgs,'pulse-stale');
  assert.equal((await pulseTools[0].execute('pulse-stale',pulseArgs)).isError,true);pulseCtx.stale=false;
  process.env.SAMANTHA_BRAIN_ONLY='0';
  assert.equal(tools.createTypedCapabilityTools(pulseCtx,{home:root}),null,'legacy baseline does not project typed tools');
  contacts.allowlistRead=savedRead;
  if(previousFlag===undefined)delete process.env.SAMANTHA_BRAIN_ONLY;else process.env.SAMANTHA_BRAIN_ONLY=previousFlag;
  console.log('typed-capability-tools: PASS (pinned canonical projection, exact host invocation, owner isolation, no replay, canonical app invocation)');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
