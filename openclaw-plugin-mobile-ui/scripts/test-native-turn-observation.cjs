// Captured S24 SDK types; UUIDs, clocks and identities below are authored, with no customer data.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
(async()=>{
 const capture=JSON.parse(await fs.readFile(path.join(__dirname,'../fixtures/s24-2026-10-25-turn-measurement/sdk-source-metadata.json'),'utf8'));
 const captured=JSON.stringify(capture);assert(captured.includes('Per-turn run identifier (UUID)'));assert(captured.includes('Conversation target id'));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-turn-observation-'));
 const realMono=process.hrtime.bigint;let now=1000000n;process.hrtime.bigint=()=>now*1000000n;
 process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_BRAIN_ONLY='1';
 const key='agent:main:whatsapp:direct:+19995550123',owners=()=>new Set(['+19995550123']);
 await fs.writeFile(path.join(root,'openclaw.json'),JSON.stringify({commands:{ownerAllowFrom:['whatsapp:+19995550123']}}));
 const client=require('../dist/companion/openclawAgentClient');let gatewayCalls=0;
 client.callOpenClawGateway=async()=>{gatewayCalls++;throw Error('unexpected_gateway_call')};
 const runs=require('../dist/companion/runs'),{createNativeTurnProgressOwner}=require('../dist/nativeTurnProgressOwner');
 const owner=createNativeTurnProgressOwner({owners,enabled:()=>true});
 const {nativeTurnProgressHooks,activeObservedNativeWhatsAppRun}=require('../dist/nativeTurnProgress');
 const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
 const ctx=n=>({channelId:'whatsapp',sessionKey:key,runId:id(n),accountId:'default'});
 let posts=0;const hooks=nativeTurnProgressHooks({owners,enabled:()=>true,post:async(i,b)=>{posts++;return owner.observe(i,b)}});
 let server;
 try{
  await hooks.received({content:'private-authored-content'},ctx(1));assert.equal(posts,1);
  assert.equal((await runs.activeObservedNativeWhatsAppRun(key)).runId,id(1));
  await hooks.received({},ctx(1));assert.equal(posts,2,'duplicate observation uses the same registry row');
  for(const c of [{...ctx(2),agentId:'contacts'},{...ctx(2),sessionKey:'agent:main:whatsapp:direct:+19995550999'},
    {...ctx(2),channel:'telegram'},{...ctx(2),runId:'not-a-uuid'}])await hooks.received({},c);
  await hooks.received({runId:id(3)},ctx(2));await hooks.received({sessionKey:'different'},ctx(2));assert.equal(posts,2);
  now+=35000n;const afterBudget=await runs.activeObservedNativeWhatsAppRun(key);
  assert.equal(afterBudget.runId,id(1));assert(afterBudget.deadlineAt>Date.now()+500000,'Stop observation stays fresh after delivery budget 30 s');
  await hooks.received({},ctx(2));assert.equal(await runs.activeObservedNativeWhatsAppRun(key),null,'two live exact-session observations are ambiguous');
  assert.equal((await runs.activeObservedNativeWhatsAppRun(key,{excludeRunId:id(2)})).runId,id(1));
  await hooks.ended({success:true},{...ctx(2),channel:'whatsapp',channelId:'+19995550123',agentId:'main'});
  assert.equal((await runs.nativeTurnProgressState(id(2))).state,'done','AgentContext channelId is target; channel owns routing');
  await hooks.received({},ctx(2));assert.equal((await runs.nativeTurnProgressState(id(2))).state,'done','duplicate ingress cannot resurrect ended row');
  const all=await runs.conversationSummariesPage();assert.equal(all.items.length,0,'observations never create product conversations');
  assert.deepEqual((await runs.comprehensionRunFacts()).facts,[],'observations never count as comprehension');
  const state=JSON.parse(await fs.readFile(path.join(root,'clawmobile-companion/runs.json'),'utf8'));
  assert.equal(state.runs.length,2);assert(!JSON.stringify(state).includes('private-authored-content'));
  assert.equal(await runs.retainedConversation(state.runs[0].sessionId),null);assert.equal(gatewayCalls,0);
  now+=600001n;assert.equal(await runs.activeObservedNativeWhatsAppRun(key),null,'expired observation cannot nominate a run');
  const {route}=require('../dist/companion/server');server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.CLAWMOBILE_COMPANION_PORT=String(server.address().port);
  const request=(body,headers={})=>fetch('http://127.0.0.1:'+server.address().port+'/v1/runs/'+id(3)+'/measurement',{
    method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const ingress={operation:'native_ingress',sessionKey:key,observedMonoMs:Number(now)},header={'x-clawmobile-owner-flow':'v1'};
  assert.equal((await request(ingress)).status,403);assert.equal((await request(ingress,{...header,origin:'https://example.invalid'})).status,403);
  assert.equal((await request({...ingress,extra:true},header)).status,400);
  assert.equal((await request({...ingress,operation:'__proto__'},header)).status,400);
  assert.equal((await request({...ingress,observedMonoMs:Number(now)+1},header)).status,400);
  assert.equal((await request({...ingress,sessionKey:{}},header)).status,403);
  const accepted=await request(ingress,header);assert.equal(accepted.status,200);assert.equal(accepted.headers.get('cache-control'),'no-store');
  assert.equal((await activeObservedNativeWhatsAppRun(key)).runId,id(3),'read-only adapter works without an exclusion UUID');
  assert.equal(await activeObservedNativeWhatsAppRun(key,{excludeRunId:id(3)}),null);
  assert.equal((await request({operation:'native_active',sessionKey:key,excludeRunId:{}},header)).status,400);
  // Process epoch revalidation: persisted observations from a previous Companion are not current evidence.
  const saved=JSON.parse(await fs.readFile(path.join(root,'clawmobile-companion/runs.json'),'utf8'));
  saved.runs.find(r=>r.runId===id(3)).nativeTurn.clockEpoch='previous-owner-process';
  await fs.writeFile(path.join(root,'clawmobile-companion/runs.json'),JSON.stringify(saved));
  assert.equal(await runs.activeObservedNativeWhatsAppRun(key),null);assert.equal(gatewayCalls,0);
  console.log('native turn observation: captured SDK channel shapes, UUID identity, 10-minute freshness, no history/metrics, loopback guards PASS');
 }finally{
  process.hrtime.bigint=realMono;
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  delete process.env.CLAWMOBILE_COMPANION_PORT;await fs.rm(root,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
