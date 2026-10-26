// Real installed SDK metadata is captured alongside this test; effects, identities and clocks below are authored doubles.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-turn-progress-'));process.env.OPENCLAW_STATE_DIR=root;
 const runs=require('../dist/companion/runs'),{nativeTurnProgressHooks}=require('../dist/nativeTurnProgress');
 const {createNativeTurnProgressOwner}=require('../dist/nativeTurnProgressOwner');
 const sdk=require('../fixtures/s24-2026-10-25-turn-measurement/sdk-source-metadata.json');
 assert.ok(sdk.captures.every(c=>c.state==='completed'&&c.exitCode===0));
 assert.ok(sdk.captures.some(c=>c.stdout.includes('Per-turn run identifier (UUID)')));
 assert.ok(sdk.captures.some(c=>c.stdout.includes('durationMs: number')));
 const realNow=Date.now,realMono=process.hrtime.bigint;let now=1792900000000,mono=1000000;
 Date.now=()=>now;process.hrtime.bigint=()=>BigInt(mono)*1000000n;
 const own='+15550123456',sessionKey='agent:main:whatsapp:direct:'+own,scheduled=[],sent=[],logs=[],realLog=console.log;
 console.log=(...args)=>{if(String(args[0]).startsWith('[turn]'))logs.push(args[0]);};
 let fail=false;const owner=createNativeTurnProgressOwner({enabled:()=>true,owners:()=>new Set([own]),
  timer:(fn,delay)=>{const t={fn,delay,unref(){}};scheduled.push(t);return t;},clear:t=>{t.cancelled=true;},
  send:async p=>{sent.push(p);if(fail)throw Error('uncertain transport');return {messageId:'authored-send-receipt'};}});
 const changes=[],subscription=runs.subscribeConversationChanges(event=>changes.push(event));
 const posts=[];const hooks=nativeTurnProgressHooks({enabled:()=>true,owners:()=>new Set([own]),post:async(id,body)=>{posts.push(body);return owner.observe(id,body);}});
 const ctx=runId=>({runId,sessionKey,channelId:'whatsapp',agentId:'main',accountId:'default'});
 const wait=async(test)=>{const end=realNow()+1500;while(!await test()){assert.ok(realNow()<end,'bounded test observation');await new Promise(r=>setTimeout(r,5));}};
 try{
  await hooks.received({runId:'b75e10b4-2117-9a2a-6ef8-a16f09930d11',content:'Private fixture text is ignored.'},ctx('b75e10b4-2117-9a2a-6ef8-a16f09930d11'));
  await hooks.received({runId:'b75e10b4-2117-9a2a-6ef8-a16f09930d11'},ctx('b75e10b4-2117-9a2a-6ef8-a16f09930d11'));assert.equal(scheduled.length,1);assert.equal(scheduled[0].delay,30000);
  await hooks.received({runId:'foreign'},{...ctx('foreign'),sessionKey:'agent:contacts:whatsapp:direct:'+own});assert.equal(scheduled.length,1);
  await hooks.received({runId:'mismatch'},ctx('other-id'));assert.equal(scheduled.length,1);
  assert.equal((await runs.activeObservedNativeWhatsAppRun(sessionKey)).runId,'b75e10b4-2117-9a2a-6ef8-a16f09930d11');
  assert.equal(await runs.activeObservedNativeWhatsAppRun(sessionKey,{excludeRunId:'b75e10b4-2117-9a2a-6ef8-a16f09930d11'}),null);
  now+=30000;mono+=30000;scheduled[0].fn();await wait(async()=>sent.length===1&&(await runs.nativeTurnProgressState('b75e10b4-2117-9a2a-6ef8-a16f09930d11')).notice==='accepted');
  assert.equal(sent[0].to,own);assert.equal(sent[0].message,'Je reviens vers toi.');assert.ok(sent[0].idempotencyKey.startsWith('samantha-progress-'));
  await hooks.received({runId:'b75e10b4-2117-9a2a-6ef8-a16f09930d11'},ctx('b75e10b4-2117-9a2a-6ef8-a16f09930d11'));assert.equal(scheduled.length,1,'accepted notice is never scheduled twice');
  await hooks.stage({durationMs:1234,model:'gpt-5.6-sol',provider:'openai'},ctx('b75e10b4-2117-9a2a-6ef8-a16f09930d11'),'model');
  await hooks.ended({success:true},ctx('b75e10b4-2117-9a2a-6ef8-a16f09930d11'));
  await hooks.sent({success:true}, {...ctx('b75e10b4-2117-9a2a-6ef8-a16f09930d11'),runId:undefined});assert.equal(logs.length,0,'missing outbound runId cannot be guessed from a session');
  await hooks.sent({success:true,runId:'b75e10b4-2117-9a2a-6ef8-a16f09930d11'},ctx('b75e10b4-2117-9a2a-6ef8-a16f09930d11'));await hooks.sent({success:true,runId:'b75e10b4-2117-9a2a-6ef8-a16f09930d11'},ctx('b75e10b4-2117-9a2a-6ef8-a16f09930d11'));assert.equal(logs.length,1);
  const facts=await runs.turnMeasurementFacts();assert.equal(facts.facts[0].measurement.route,null);assert.equal(facts.facts[0].measurement.firstSignMs,null);
  assert.equal(facts.facts[0].measurement.decisionMs,1234);assert.equal(facts.facts[0].measurement.model,'openai/gpt-5.6-sol');
  const stored=JSON.parse(await fs.readFile(path.join(root,'clawmobile-companion/runs.json'),'utf8'));assert.equal(stored.runs[0].text,'');assert.equal(stored.runs[0].result,undefined);
  assert.ok(!logs[0].includes(own)&&!logs[0].includes('Private'));assert.ok(posts.every(p=>!('content'in p)));
  await hooks.received({runId:'0fbd189c-efd1-2009-1afc-9513e35ff2fe'},ctx('0fbd189c-efd1-2009-1afc-9513e35ff2fe'));const cancelled=scheduled.at(-1);
  await hooks.received({runId:'cbd05ccd-b0f7-c144-9950-dd9513084998'},ctx('cbd05ccd-b0f7-c144-9950-dd9513084998'));assert.equal(await runs.activeObservedNativeWhatsAppRun(sessionKey),null,'two active exact-session turns are ambiguous');
  await hooks.ended({success:true},ctx('0fbd189c-efd1-2009-1afc-9513e35ff2fe'));assert.equal(cancelled.cancelled,true);
  now+=30000;mono+=30000;cancelled.fn();await new Promise(r=>setTimeout(r,20));assert.equal(sent.length,1,'late callback cannot announce after finalization');
  fail=true;scheduled.at(-1).fn();await wait(async()=>(await runs.nativeTurnProgressState('cbd05ccd-b0f7-c144-9950-dd9513084998')).notice==='uncertain');
  const count=sent.length;await hooks.received({runId:'cbd05ccd-b0f7-c144-9950-dd9513084998'},ctx('cbd05ccd-b0f7-c144-9950-dd9513084998'));assert.equal(sent.length,count,'uncertain effects never send again');assert.equal(count,2);
  await hooks.ended({success:true},ctx('cbd05ccd-b0f7-c144-9950-dd9513084998'));
  await hooks.received({runId:'f2b65a23-ffa9-1899-7719-7511b090f3ec'},ctx('f2b65a23-ffa9-1899-7719-7511b090f3ec'));await hooks.sent({success:true},ctx('f2b65a23-ffa9-1899-7719-7511b090f3ec'));assert.equal(logs.length,1,'delivery before agent_end waits for final owner state');
  await hooks.ended({success:true},ctx('f2b65a23-ffa9-1899-7719-7511b090f3ec'));assert.equal(logs.length,2,'delivery/end race produces exactly one measurement');
  await assert.rejects(owner.observe('f2b65a23-ffa9-1899-7719-7511b090f3ec',{operation:'native_end',sessionKey:'agent:contacts:whatsapp:direct:'+own,success:true}),e=>e.statusCode===403);
  await assert.rejects(owner.observe('f2b65a23-ffa9-1899-7719-7511b090f3ec',{operation:'native_end',sessionKey,success:true,content:'private'}),e=>e.statusCode===400);
  await hooks.received({runId:'d8077c1f-ba13-1715-a344-8695080fcc9a'},ctx('d8077c1f-ba13-1715-a344-8695080fcc9a'));now+=1200000;mono+=1200000;
  assert.equal(await runs.activeObservedNativeWhatsAppRun(sessionKey),null,'stale observation cannot select an abort candidate');
  const gateway=require('../dist/companion/openclawAgentClient'),read=gateway.callOpenClawGateway;const reads=[];
  gateway.callOpenClawGateway=async(method,params)=>{reads.push({method,params});return {sessions:[]};};
  try{assert.deepEqual(await runs.listRunSummaries({limit:10}),[]);await runs.awaitRunInactivity();assert.equal(reads.length,1,'empty product history keeps its one canonical legacy page read, with no metadata-row fanout');assert.equal(reads[0].method,'sessions.list');}
  finally{gateway.callOpenClawGateway=read;}
  assert.deepEqual(changes,[],'native measurement rows never create product conversation events');
  // Real SDK public transcript shape: original dispatch clock/account, exact adoption, and out-of-order delivery/end.
  const uuid=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
  const originalStamp=mono-5000;
  const transcript=(id,stamp,adoptedBy,accountId='owner-named-account')=>({target:{agentId:'main',sessionKey},messageId:'authored-source-anchor',
   message:{role:'user',__openclaw:{senderIsOwner:true,transport:{channel:'whatsapp',ingressRunId:id,ingressObservedMonoMs:stamp,...(accountId?{accountId}:{})},
    ...(adoptedBy?{steerTargetRunId:adoptedBy}:{})}}});
  await hooks.transcript(transcript(uuid(101),originalStamp));const targetTimer=scheduled.at(-1);
  assert.equal(targetTimer.delay,25000,'budget starts at native dispatch, not delayed transcript callback');
  await hooks.transcript(transcript(uuid(102),mono,uuid(101)));const aliasTimer=scheduled.at(-1);
  assert.equal(aliasTimer.cancelled,true,'adoption cancels only the exact alias timer');
  assert.equal((await runs.activeObservedNativeWhatsAppRun(sessionKey)).runId,uuid(101));
  const deadline=(await runs.nativeTurnProgressState(uuid(102))).deadlineAt;
  await hooks.transcript(transcript(uuid(102),mono,uuid(101)));assert.equal((await runs.nativeTurnProgressState(uuid(102))).deadlineAt,deadline);
  now+=25000;mono+=25000;fail=false;const sentBefore=sent.length;targetTimer.fn();await wait(async()=>sent.length===sentBefore+1);
  assert.equal(sent.at(-1).accountId,'owner-named-account','the actual native account, never default, owns managed send');
  const beforeBoundLogs=logs.length;
  await hooks.sent({success:true,runId:uuid(101)},ctx(uuid(101)));await hooks.ended({success:true},ctx(uuid(101)));
  assert.equal(logs.length,beforeBoundLogs+2,'one measurement per real ingress bound to the exact delivered run');
  await hooks.sent({success:true,runId:uuid(101)},ctx(uuid(101)));assert.equal(logs.length,beforeBoundLogs+2);
  const boundRows=JSON.parse(await fs.readFile(path.join(root,'clawmobile-companion/runs.json'),'utf8')).runs;
  assert.equal(boundRows.find(r=>r.runId===uuid(101)).turnMeasurement.usefulMs,30000);
  const aliasMeasurement=boundRows.find(r=>r.runId===uuid(102)).turnMeasurement;
  assert.equal(aliasMeasurement.usefulMs,25000);assert.equal(aliasMeasurement.decisionMs,null);assert.equal(aliasMeasurement.route,null);
  // A real delivery/end may precede ingress persistence. Placeholders never claim a clock or arm a notice.
  const timerCount=scheduled.length;const late=uuid(103),lateAlias=uuid(104),lateStarted=mono-1000;
  await owner.observe(late,{operation:'native_delivery',sessionKey,observedMonoMs:mono});
  await owner.observe(late,{operation:'native_end',sessionKey,success:true});
  await owner.observe(lateAlias,{operation:'native_adoption',sessionKey,targetRunId:late,observedMonoMs:mono});
  assert.equal((await runs.nativeTurnProgressState(late)).ingressPending,true);
  const logsBeforeLate=logs.length;
  await hooks.transcript(transcript(lateAlias,lateStarted,late));await hooks.transcript(transcript(late,lateStarted));
  assert.equal(scheduled.length,timerCount);assert.equal(logs.length,logsBeforeLate+2,'late true ingress finalizes exact ended bindings once');
  assert.equal((await runs.nativeTurnProgressState(late)).state,'done');
  // Unknown account cannot turn a logical owner peer into a fabricated default-account send.
  await hooks.transcript(transcript(uuid(105),mono,undefined,null));const noAccount=scheduled.at(-1);
  now+=30000;mono+=30000;const sendsBeforeMissingAccount=sent.length;noAccount.fn();await new Promise(r=>setTimeout(r,20));
  assert.equal(sent.length,sendsBeforeMissingAccount);await hooks.ended({success:true},ctx(uuid(105)));

  // Authored volume from the owner's serialized new-schema row; no private S24 message is invented.
  const registryPath=path.join(root,'clawmobile-companion/runs.json'),ledger=JSON.parse(await fs.readFile(registryPath,'utf8'));
  const seed=ledger.runs.find(r=>r.runId==='d8077c1f-ba13-1715-a344-8695080fcc9a');
  ledger.runs=Array.from({length:505},(_,i)=>({...seed,runId:'native-volume-'+i,acceptedAt:now-i,updatedAt:now-i}));
  await fs.writeFile(registryPath,JSON.stringify(ledger));
  await runs.recordNativeWhatsAppIngress('f9dc13aa-2683-0742-babf-72304da99c3e',sessionKey,'default',mono);
  assert.equal((await runs.turnMeasurementFacts()).retainedRuns,500,'native rows must not survive registry eviction in an unbounded memory copy');


 }finally{subscription.close();Date.now=realNow;process.hrtime.bigint=realMono;console.log=realLog;await fs.rm(root,{recursive:true,force:true});}
 console.log('PASS native owner deadline, exact SDK correlation, unique canonical notice and delivery/end race');
})().catch(e=>{console.error(e);process.exitCode=1;});
