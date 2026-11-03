// Real S24 timing + authored frames from installed SDK2026.9.6; no phone/provider/effect.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-observation-'));
process.env.OPENCLAW_STATE_DIR=home;process.env.CLAWMOBILE_AGENT_ID='main';
const captured=require('../fixtures/s24-2026-10-25-gateway-observation/native-timing.json');
const sdkContract=require('../fixtures/s24-2026-10-25-gateway-observation/sdk-contract.json');
const nativeTerminal=require('../fixtures/s24-2026-10-26-gateway-terminal-timing/native-timing.json');
const client=require('../dist/companion/openclawAgentClient');
let calls=[],recovery,serial=0;
client.callOpenClawGateway=async(method,params,options)=>{
 calls.push({method,params});assert.ok(options?.timeoutMs<=5500);
 if(method==='sessions.list')return {sessions:recovery?.key===params.search?[{key:recovery.key,sessionId:'public-fixture-session'}]:[]};
 if(method==='chat.history')return {messages:recovery?.messages||[]};
 if(method==='progressCard.get')return {card:{revision:1,updatedAt:Date.now(),steps:[{step:'Je prépare la réponse',status:'in_progress'}]}};
 throw Error('unexpected owner read');
};
const runs=require('../dist/companion/runs');
const expected=sid=>'agent:main:companion-chat-'+sid;
const terminal=(id,text)=>({runId:id,status:'ok',summary:'completed',result:{payloads:[{text}],meta:{stopReason:'stop'}}});
async function create(sid,owner=true){const r=await runs.reserveSubmittedRun('Public authored question',sid,'client-'+sid+'-'+(++serial),{ownerAdmitted:owner,userText:'Public authored question'});return r.status.runId;}
function event(id,sid,seq,data,stream='tool'){return {type:'event',event:'agent',payload:{runId:id,sessionKey:expected(sid),seq,stream,data}};}
(async()=>{try{
 assert.equal(Math.round((captured.metrics.brain_session_started-captured.metrics.brain_run_accepted)*1000),21798);
 assert.equal(sdkContract.capture.runtimeCapture,true);assert.ok(sdkContract.parts.every(p=>p.found&&/^[a-f0-9]{64}$/.test(p.sha256)));assert.match(sdkContract.parts[0].excerpt,/pending.expectFinal/);assert.match(sdkContract.parts[1].excerpt,/\n\t\t\tresult/);
 assert.equal(captured.brain.tool_calls,0);assert.equal(captured.ownerTransport,'admin_admitted');
 assert.equal(nativeTerminal.metrics.sessionStartedAt-nativeTerminal.metrics.acceptedAt,10035);
 assert.equal(nativeTerminal.metrics.terminalRpcLoggedAt-nativeTerminal.metrics.sessionEndedAt,194);
 assert.equal(nativeTerminal.metrics.registryUpdatedAt-nativeTerminal.metrics.terminalRpcLoggedAt,13904);
 assert.equal(nativeTerminal.metrics.usefulUiMs,null,'a later UI capture cannot fabricate the first visible answer timestamp');
 const id=await create('observed');const o=await runs.observeGatewayRun(id,expected('observed'));
 assert.equal(await runs.activeObservedGatewayRun(id,expected('observed')),false,'admission without actual send is not active transport proof');
 o.sent();await runs.getRunStatus(id);
 assert.equal(await runs.activeObservedGatewayRun(id,expected('other-session')),false);
 assert.equal(await runs.activeObservedGatewayRun('unstored-wa-run',expected('observed')),false);
 assert.equal(await runs.activeObservedGatewayRun(id,expected('observed')),true);
 await assert.rejects(runs.observeGatewayRun(id,expected('observed')),/already_following/);
 await runs.conversationSummariesPage();await runs.getConversationTurns('observed');assert.equal(calls.length,0,'conversation metadata reuses the observed owner view while a turn follows its socket');
 const read=await Promise.all(Array.from({length:30},()=>runs.getRunStatus(id)));assert.ok(read.every(r=>r.state==='running'));assert.equal(calls.length,0,'polls while request follows final/event stream perform no Gateway reads');
 o.event(event(id,'wrong-session',1,{phase:'start',toolCallId:'call1',args:{title:'Wrong session'}}));
 o.event(event('other-run','observed',1,{phase:'start',toolCallId:'call1',args:{title:'Wrong run'}}));
 o.event(event(id,'observed',2,{phase:'start',toolCallId:'call1',args:{title:'Je prépare la réponse'}}));
 o.event(event(id,'observed',2,{phase:'start',toolCallId:'duplicate',args:{title:'Duplicate'}}));
 o.event(event(id,'observed',1,{phase:'result',toolCallId:'call1'}));
 o.event(event(id,'observed',3,{text:'Never a verified result'},'assistant'));
 await o.final(terminal(id,'Réponse finale vérifiée.'));
 o.event(event(id,'observed',4,{phase:'start',toolCallId:'late',args:{title:'Late'}}));
 assert.equal(await runs.activeObservedGatewayRun(id,expected('observed')),false,'terminal run cannot be aborted as an active target');
 const done=await runs.getRunStatus(id);assert.equal(done.state,'done');assert.equal(done.result,'Réponse finale vérifiée.');assert.equal(done.ownerTransport,'admin_admitted');assert.equal(calls.length,0);
 assert.ok(done.progress.events.some(e=>e.callId==='call1'));assert.ok(done.progress.events.every(e=>!['late','duplicate'].includes(e.callId)));assert.ok(!JSON.stringify(done).includes('Wrong session'));
 await runs.listRuns();assert.equal(calls.length,0,'list views of followed runs remain local');
 // A blocked owner read must not move the SDK terminal-receipt timestamp. Wall-clock jumps
 // cannot become queue durations: those elapsed waits use only performance.now().
 const timed=await create('timed-terminal'),timedObserver=await runs.observeGatewayRun(timed,expected('timed-terminal'));
 const realNow=Date.now,originalRead=fs.promises.readFile,performanceDescriptor=Object.getOwnPropertyDescriptor(globalThis,'performance');
 let clock=realNow(),monotonic=1000,entered,release;
 const enteredRead=new Promise(resolve=>{entered=resolve}),readGate=new Promise(resolve=>{release=resolve});
 try{
  Date.now=()=>clock;Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>monotonic}});
  const sentAt=clock;timedObserver.sent();await runs.activeObservedGatewayRun(timed,expected('timed-terminal'));
  const file=path.join(home,'clawmobile-companion/runs.json');let registry;
  // sent() intentionally does not await its queue. Observe its durable effect before
  // blocking the later terminal read, rather than racing that first queued write.
  const sendDeadline=process.hrtime.bigint()+2000000000n;
  for(;;){
   registry=JSON.parse(fs.readFileSync(file));
   if(registry.runs.find(r=>r.runId===timed)?.gatewayObservation?.timing?.requestSentAt===sentAt)break;
   assert.ok(process.hrtime.bigint()<sendDeadline,'SDK send observation was not durably recorded');
   await new Promise(resolve=>setTimeout(resolve,1));
  }
  const row=registry.runs.find(r=>r.runId===timed);assert.equal(row.gatewayObservation.timing.requestSentAt,sentAt);
  row.gatewayObservation.timing.prompt='must-not-enter-timing';row.gatewayObservation.timing.progressWaitMs=-1;fs.writeFileSync(file,JSON.stringify(registry));
  let block=true;fs.promises.readFile=async function(file,...args){
   if(block&&String(file)===path.join(home,'clawmobile-companion/runs.json')){block=false;entered();await readGate;}
   return originalRead.call(this,file,...args);
  };
  clock+=1000;const receivedAt=clock,pending=timedObserver.final(terminal(timed,'Exact terminal response.'));await enteredRead;
  clock+=14000;monotonic+=7;release();await pending;
  const observed=JSON.parse(fs.readFileSync(file)).runs.find(r=>r.runId===timed).gatewayObservation;
  assert.equal(observed.state,'settled');assert.equal(observed.timing.requestSentAt,sentAt);
  assert.equal(observed.timing.terminalReceivedAt,receivedAt);assert.equal(observed.timing.progressDrainedAt,receivedAt);
  assert.equal(observed.timing.settlementStartedAt,clock);assert.equal(observed.timing.settlementWaitMs,7,'no subtraction of wall-clock stamps for elapsed queue duration');
  assert.ok(observed.timing.progressWaitMs>=0);assert.ok(!JSON.stringify(observed).includes('must-not-enter-timing'));
  assert.ok(Object.values(observed.timing).every(Number.isSafeInteger));
 }finally{release?.();Date.now=realNow;fs.promises.readFile=originalRead;Object.defineProperty(globalThis,'performance',performanceDescriptor);}
 const ackOnly=await create('timed-ack-only'),ackObserver=await runs.observeGatewayRun(ackOnly,expected('timed-ack-only'));
 ackObserver.sent();await ackObserver.final({runId:ackOnly,status:'accepted'});
 const ackRecord=JSON.parse(fs.readFileSync(path.join(home,'clawmobile-companion/runs.json'))).runs.find(r=>r.runId===ackOnly);
 assert.equal(ackRecord.state,'unknown');assert.equal(ackRecord.gatewayObservation.state,'reconcile');
 assert.ok(!('terminalReceivedAt' in (ackRecord.gatewayObservation.timing||{})),'an acknowledgement has no accepted terminal timing');
 const denied=await create('not-admitted',false);await assert.rejects(runs.observeGatewayRun(denied,expected('not-admitted')),/not_admitted/);
 const lost=await create('lost');const lo=await runs.observeGatewayRun(lost,expected('lost'));await lo.lost(true);
 await Promise.all(Array.from({length:20},()=>runs.getRunStatus(lost)));assert.equal(calls.filter(c=>c.method==='sessions.list').length,1,'concurrent loss recovery claims one bounded exact-session read');
 for(let i=0;i<10;i++)await runs.getRunStatus(lost);
 assert.equal(calls.filter(c=>c.method==='sessions.list').length,1,'no repeated polling after unavailable reconciliation');
 assert.equal((await runs.getRunStatus(lost)).state,'unknown');assert.ok(calls.every(c=>c.method!=='agent'),'recovery never resubmits');
 assert.equal(runs.gatewayTerminalResult({runId:id,status:'accepted'},id),null);
 assert.equal(runs.gatewayTerminalResult(terminal('other','Wrong'),id),null);
 assert.equal(runs.gatewayTerminalResult({runId:id,status:'ok',summary:'completed'},id),null,'a narrative ACK cannot become completion');
 for(const p of [{text:'hidden',visible:false},{text:'reasoning',isReasoning:true},{text:'notice',isStatusNotice:true},{text:'NO_REPLY'},{text:'warning',isError:true}])assert.equal(runs.gatewayTerminalResult({runId:id,status:'ok',result:{payloads:[p]}},id),null);
 assert.equal(runs.gatewayTerminalResult({runId:id,status:'ok',result:{meta:{error:{kind:'failed'}},payloads:[{text:'unsafe'}]}},id),null);
 // A Companion restart invalidates the following epoch. Simulate its durable receipt, not an effect replay.
 const file=path.join(home,'clawmobile-companion/runs.json'),registry=JSON.parse(fs.readFileSync(file));
 const stale=registry.runs.find(r=>r.runId===lost);stale.gatewayObservation={version:1,epoch:'00000000-0000-4000-8000-000000000000',state:'following',deadlineAt:Date.now()+120000};
 fs.writeFileSync(file,JSON.stringify(registry));
 delete require.cache[require.resolve('../dist/companion/runs')];const restarted=require('../dist/companion/runs');
 await restarted.getRunStatus(lost);await restarted.getRunStatus(lost);assert.equal(calls.filter(c=>c.method==='sessions.list').length,2,'restart gets one read, never an agent dispatch');
 const card=await create('card');const co=await runs.observeGatewayRun(card,expected('card'));
 co.event(event(card,'card',1,{phase:'result',name:'progress_card',toolCallId:'card1'}));
 await co.final(terminal(card,'Fini.'));assert.equal(calls.filter(c=>c.method==='progressCard.get').length,1,'card writer triggers one read, not each UI poll');
 assert.equal((await runs.getRunStatus(card)).progress.card.steps[0].label,'Je prépare la réponse');
 // Recovery accepts only a unique fresh terminal owner turn, never another/unfinished turn.
 for(const kind of ['fresh','old','duplicate','unfinished','suppressed']){
  const sid='recover-'+kind,id=await create(sid),o=await runs.observeGatewayRun(id,expected(sid));await o.lost(true);
  const now=Date.now(),at=kind==='old'?now-60000:now-2;
  const user={role:'user',content:[{type:'text',text:'Public authored question'}],timestamp:at};
  const answer={role:'assistant',content:[{type:'text',text:kind==='suppressed'?'NO_REPLY':'Réponse récupérée.'}],stopReason:kind==='unfinished'?'toolUse':'stop',timestamp:at+1};
  recovery={key:expected(sid),messages:kind==='duplicate'?[user,answer,user,answer]:[user,answer]};
  const recovered=await runs.getRunStatus(id);assert.equal(recovered.state,kind==='fresh'?'done':'unknown',kind);
  if(kind==='fresh')assert.equal((await runs.getRunStatus(id)).result,'Réponse récupérée.');
  assert.equal(await runs.activeObservedGatewayRun(id,expected(sid)),false);
 }
 recovery=undefined;
 const late=await create('late-terminal'),lateObserver=await runs.observeGatewayRun(late,expected('late-terminal'));await lateObserver.lost(true);await runs.getRunStatus(late);await lateObserver.final(terminal(late,'Preuve terminale plus forte.'));assert.equal((await runs.getRunStatus(late)).state,'done','an exact terminal RPC may correct unknown after a reconciliation race');
 const burst=await create('burst'),bo=await runs.observeGatewayRun(burst,expected('burst'));
 for(let seq=1;seq<=200;seq++)bo.event(event(burst,'burst',seq,{phase:'start',toolCallId:'burst'+seq,args:{title:'Étape annoncée'}}));
 await bo.final(terminal(burst,'Fini sans file infinie.'));assert.ok((await runs.getRunStatus(burst)).progress.events.length<=48);
 const active=[];for(let i=0;i<8;i++){const id=await create('active-'+i);active.push({id,observer:await runs.observeGatewayRun(id,expected('active-'+i))});}
 const overflow=await create('capacity');await assert.rejects(runs.observeGatewayRun(overflow,expected('capacity')),/capacity/);
 for(const a of active)await a.observer.final(terminal(a.id,'Fini.'));
 console.log('Gateway run observation: local polls, terminal proof, exact binding, sequence, late events, loss/restart and card invalidation PASS');
}finally{fs.rmSync(home,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
