// Deferred readback of a brain turn (S24 30/10 22:21, « Quel est l'état de mes factures »): the brain answered 0.4 s after
// the 30 s voice budget and the voice said nothing. Fixture: fixtures/s24-2026-10-30-voice-slow-brain (Companion stderr and
// Gateway run of the incident). Deterministic protocol and owner wiring only: no microphone, provider or S24 proof.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {VoiceTurnProtocol,deferredReadbackText}=require('../dist/companion/voiceTurnProtocol.js');
const brain=require('../dist/companion/voiceBrainDelegation.js');
const {ClawLiveWarmCore}=require('../dist/companion/clawLiveWarm.js');
const contract=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/protocol/voice-v2-app-companion.json'),'utf8'));
const incident=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-30-voice-slow-brain/incident.json'),'utf8'));

const REQUEST=incident.request;
const RUN=incident.gatewayRun.runId;
const ANSWER=incident.gatewayRun.result;
const NOTICE='Je te donne la réponse dès que je l\'ai.';
const BUDGET=incident.timeline.voiceBudgetMs;
const LATE=incident.timeline.answerAfterVoiceDeadlineMs;
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

/** Fake clock: the delegation runs instantly up to the voice deadline, then each later sleep waits for the test. */
function clock(){
 const c={t:0,queue:[],now:()=>c.t,sleep:(ms)=>{
  if(c.t+ms<=BUDGET){c.t+=ms;return Promise.resolve();}
  return new Promise(r=>c.queue.push(()=>{c.t+=ms;r();}));
 },async tick(){const next=c.queue.shift();if(next)next();await flush();return Boolean(next);}};
 return c;
}
/** Gateway run of the incident: running until 0.4 s after the voice deadline, then the brain's answer. */
function gatewayRun(c){
 const seen={polls:0};
 return {seen,submit:async()=>({success:true,accepted:true,submissionState:'accepted',runId:RUN,clientRunId:'voice-cap-voice-a',state:'running',result:''}),
  status:async(id)=>{assert.equal(id,RUN);seen.polls++;return c.t<BUDGET+LATE?{success:true,runId:RUN,state:'running',message:''}:{success:true,runId:RUN,state:'done',message:'',result:ANSWER};}};
}
const ticket=Object.freeze({keyId:'k',epoch:'e',clientRunId:'voice-cap-voice-a',sessionId:'samantha-05fdeb6c',admittedAt:1,expiresAt:2});
const ctx={sessionId:'samantha-05fdeb6c',clientRunId:'voice-cap-voice-a',admission:ticket,assertCurrent:()=>{}};

const control=(kind,id,extra={})=>({warmControl:{[kind]:{operationId:kind+'-'+id,sessionEpoch:'session-1',turnId:id,...extra}}});
function setup(now=()=>0){const sent=[],events=[];return {sent,events,p:new VoiceTurnProtocol(1,'session-1',x=>sent.push(x),x=>events.push(x),undefined,now,false,undefined,true)};}
function open(s,id='voice-a',text=REQUEST){
 s.p.receive(control('turnStart',id,{firstSample:0}));
 s.p.receive(control('turnEnd',id,{lastSampleExclusive:0}));
 s.p.receive(control('transcriptFinal',id,{source:'android_speech_service',text}));
}
/** Gemini's ask_samantha call on the brain turn, answered « in progress » by the app (NON_BLOCKING, SILENT). */
function asyncCall(s,id='voice-a',text=REQUEST){
 s.p.provider({toolCall:{functionCalls:[{id:'ask-'+id,name:'ask_samantha',args:{request:text}}]}});
 s.p.receive({toolResponse:{functionResponses:[{id:'ask-'+id,name:'ask_samantha',response:{result:{state:'running',source:'samantha_brain'}}}]}});
 s.p.provider({serverContent:{turnComplete:true}});
}
const payloads=s=>s.events.flatMap(x=>x.warmEvent?[x.warmEvent]:[]);
const acks=s=>s.events.flatMap(x=>x.warmAck?[x.warmAck]:[]);
const with_=(s,key)=>payloads(s).filter(x=>x.payload[key]);
/** Every text the provider was asked to say, in order: receipts (tool responses) and verbatim readbacks. */
function spoken(s){
 return s.sent.flatMap(x=>{
  const readback=x.clientContent?.turns?.[0]?.parts?.[0]?.text;
  if(typeof readback==='string'&&readback.startsWith('Read exactly'))return [JSON.parse(readback.slice(readback.indexOf('"')))];
  const final=x.toolResponse?.functionResponses?.find(r=>r.scheduling==='INTERRUPT');
  if(final)return [final.response.result.voice?.verbatim??final.response.result.text];
  return [];
 });
}
const said=(s,text)=>spoken(s).filter(v=>v===text).length;
/** The provider finished saying the current output (real boundary). */
const finish=s=>{s.p.provider({serverContent:{turnComplete:true}});s.p.provider({serverContent:{turnComplete:true}});};

/** One voice turn through the real owners: protocol.execute (opted in) → delegateVoiceTurnToBrain with the protocol as owner. */
function brainTurn(s,c,run,id='voice-a',optIn=true){
 return s.p.execute(id,REQUEST,()=>brain.delegateVoiceTurnToBrain(REQUEST,ctx,{now:c.now,sleep:c.sleep,submit:run.submit,status:run.status,
  ...(optIn?{deferred:{alive:()=>s.p.deferredAlive(id),settle:(r)=>s.p.deferredSettled(id,r)}}:{})}),{deferredReadback:optIn});
}

(async()=>{
 await test('fixture: the S24 incident is a brain turn closed by the voice budget 0.4 s before its answer',()=>{
  assert.match(incident.companionStderr[1],/\[voice-turn\] route=brain state=pending .* brain_ms=30027 total_ms=30029/);
  assert.match(incident.companionStderr[0],/\[turn\] surface=voice route=- .* total_ms=14026/);
  assert.equal(Date.parse(incident.gatewayRun.endedAt)-Date.parse(incident.gatewayRun.startedAt),29200);
  assert.equal(BUDGET,30000);assert.equal(LATE,400);
  const {_capture,...data}=incident;assert.equal(_capture.sanitized,true);
  assert.ok(!/token|cookie|\botp\b|@/i.test(JSON.stringify(data)),'sanitized capture');assert.match(incident.gatewayRun.sessionKey,/…$/);
 });

 await test('S24 race: brain answers 0.4 s after the voice deadline → notice said, then the answer said once',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
  const pending=await brainTurn(s,c,run);
  assert.equal(pending.state,'pending');assert.equal(pending.text,NOTICE);assert.equal(pending.voice.verbatim,NOTICE);
  assert.deepEqual(pending.deferredReadback,{version:1,owner:'voice_turn'});assert.equal(pending.timing.brainMs,BUDGET);
  assert.equal(brain.voiceTurnLogLine(pending,BUDGET+2),'[voice-turn] route=brain state=pending coordinator_ms=- resolve_ms=- brain_ms=30000 total_ms=30002');
  // The app reads the turn's receipt: the pending notice, on the same turn, exactly once.
  s.p.receiptReply('voice-a');assert.deepEqual(spoken(s),[NOTICE]);finish(s);
  // The same bounded read goes on after the budget; the run settled 0.4 s after the deadline.
  assert.equal(await c.tick(),true);assert.equal(c.t,BUDGET+1000);
  const ready=with_(s,'deferredReady');assert.equal(ready.length,1);assert.equal(ready[0].turnId,'voice-a');
  assert.equal(await c.tick(),false,'the follow stopped once the answer landed');
  s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
  assert.equal(acks(s).at(-1).state,'accepted');
  assert.deepEqual(with_(s,'readbackAdmitted').at(-1).payload.readbackAdmitted,{deferred:'result'});
  assert.deepEqual(spoken(s),[NOTICE,ANSWER]);finish(s);
  // Never twice: a second request for the same turn (app retry, duplicate event) is refused, nothing more is said.
  s.p.receive(control('speakDeferred','voice-readback-2',{sourceTurnId:'voice-a'}));
  assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'already_spoken');
  assert.equal(said(s,ANSWER),1);assert.equal(said(s,NOTICE),1);
  assert.ok(!payloads(s).some(x=>x.payload.protocolError),'no session error');
 });

 await test('S24 incident shape: the brain turn was retired 14 s in (onset without speech) → notice, then answer, each once',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
  const result=brainTurn(s,c,run);await flush();assert.ok(run.seen.polls>0,'the brain run is in flight');
  // ~14 s: an onset retires the brain turn in the app (interrupt + new turn); the recognizer heard no speech.
  s.p.receive(control('interrupt','voice-a',{outputGenerationId:'out-voice-a'}));
  s.p.receive(control('turnStart','voice-noise',{firstSample:0}));
  s.p.receive(control('turnEnd','voice-noise',{lastSampleExclusive:0}));
  s.p.receive(control('transcriptFinal','voice-noise',{source:'android_speech_service',text:'',noSpeech:true}));
  s.p.provider({serverContent:{turnComplete:true}});
  const pending=await result;assert.equal(pending.state,'pending');
  // Today the receipt of a retired turn is refused: before this fix nothing at all was said.
  s.p.receiptReply('voice-a');assert.equal(with_(s,'receiptRefused').at(-1).payload.receiptRefused.reason,'interrupted');
  assert.deepEqual(spoken(s),[]);
  // The deferred readback owner says the notice now…
  s.p.receive(control('speakDeferred','voice-readback-n',{sourceTurnId:'voice-a'}));
  assert.deepEqual(with_(s,'readbackAdmitted').at(-1).payload.readbackAdmitted,{deferred:'notice'});
  assert.deepEqual(spoken(s),[NOTICE]);
  // …a second notice is never said while the run still works…
  s.p.receive(control('speakDeferred','voice-readback-n2',{sourceTurnId:'voice-a'}));
  assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'nothing_due');
  finish(s);
  // …and the answer when the run lands.
  await c.tick();assert.equal(with_(s,'deferredReady').length,1);
  s.p.receive(control('speakDeferred','voice-readback-r',{sourceTurnId:'voice-a'}));
  assert.deepEqual(spoken(s),[NOTICE,ANSWER]);
 });

 await test('an answer that lands before the receipt is read replaces the notice: said once, no notice',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
  await brainTurn(s,c,run);await c.tick();assert.equal(with_(s,'deferredReady').length,1);
  s.p.receiptReply('voice-a');
  assert.deepEqual(spoken(s),[ANSWER]);finish(s);
  s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
  assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'already_spoken');
  assert.equal(said(s,ANSWER),1);assert.equal(said(s,NOTICE),0);
 });

 await test('the same holds without the asynchronous tool (classic receipt prompt)',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);s.p.provider({serverContent:{turnComplete:true}});
  await brainTurn(s,c,run);s.p.receiptReply('voice-a');
  const prompt=s.sent.at(-1).clientContent.turns[0].parts[0].text;assert.ok(prompt.includes('«'+NOTICE+'»'));
  finish(s);await c.tick();
  s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
  assert.equal(said(s,ANSWER),1);
 });

 for(const [label,newer] of [['a newer request','Et mes recharges Orange ?'],['« stop »','Stop']]) {
  await test(`${label} supersedes the deferred answer: never said, the follow stops`,async()=>{
   const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
   await brainTurn(s,c,run);s.p.receiptReply('voice-a');finish(s);
   open(s,'voice-b',newer);
   let executed=0;await s.p.execute('voice-b',newer,async()=>{executed++;return {state:'done',text:'Ok.'};});
   assert.equal(executed,1);
   const dropped=with_(s,'deferredDropped');assert.equal(dropped.length,1);assert.deepEqual(dropped[0].payload.deferredDropped,{reason:'superseded'});
   assert.equal(dropped[0].turnId,'voice-a');
   const polls=run.seen.polls;assert.equal(await c.tick(),true);assert.equal(run.seen.polls,polls,'no read after the turn was superseded');
   assert.equal(with_(s,'deferredReady').length,0);
   s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
   assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'superseded');
   assert.equal(said(s,ANSWER),0);
  });
 }

 await test('a social reflex (« merci ») never executes and never cancels the deferred answer',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
  await brainTurn(s,c,run);s.p.receiptReply('voice-a');finish(s);
  open(s,'voice-thanks','Merci');s.p.provider({serverContent:{turnComplete:true}});
  await c.tick();
  s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
  assert.equal(said(s,ANSWER),1);
 });

 await test('a closed voice session says nothing more: the answer stays in the discussion (run owner)',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
  await brainTurn(s,c,run);s.p.receiptReply('voice-a');finish(s);
  s.p.close();const polls=run.seen.polls;
  await c.tick();assert.equal(run.seen.polls,polls);assert.equal(with_(s,'deferredReady').length,0);
  assert.equal(said(s,ANSWER),0);
 });

 await test('an answer still unsaid 90 s after it landed is dropped as stale',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
  await brainTurn(s,c,run);s.p.receiptReply('voice-a');finish(s);await c.tick();
  c.t+=90_000;
  s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
  assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'expired');
  assert.deepEqual(with_(s,'deferredDropped').at(-1).payload.deferredDropped,{reason:'expired'});
  assert.equal(said(s,ANSWER),0);
 });

 await test('owner speech has priority: refused while Amine speaks, said once he stops',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
  await brainTurn(s,c,run);s.p.receiptReply('voice-a');finish(s);await c.tick();
  s.p.receive(control('turnStart','voice-c',{firstSample:0}));
  s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
  assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'not_admissible');
  s.p.receive(control('turnEnd','voice-c',{lastSampleExclusive:0}));
  s.p.receive(control('transcriptFinal','voice-c',{source:'android_speech_service',text:'',noSpeech:true}));
  s.p.provider({serverContent:{turnComplete:true}});
  s.p.receive(control('speakDeferred','voice-readback-2',{sourceTurnId:'voice-a'}));
  assert.equal(said(s,ANSWER),1);
  // Barge-in during the readback cuts it; it is never said again (at most once).
  s.p.receive(control('turnStart','voice-d',{firstSample:0}));
  s.p.receive(control('speakDeferred','voice-readback-3',{sourceTurnId:'voice-a'}));
  assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'already_spoken');
  assert.equal(said(s,ANSWER),1);
 });

 await test('older app (no opt-in): no follow, no deferred event, its own A1 readback stays the single owner',async()=>{
  const c=clock(),run=gatewayRun(c),s=setup(c.now);open(s);asyncCall(s);
  const pending=await brainTurn(s,c,run,'voice-a',false);
  assert.equal(pending.state,'pending');assert.equal(pending.text,NOTICE);assert.equal(pending.deferredReadback,undefined);
  assert.equal(await c.tick(),false,'nothing follows the run for an app that did not opt in');
  s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
  assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'not_deferred');
  // The A1 speakResult path of the deployed app is unchanged.
  s.p.receiptReply('voice-a');finish(s);
  s.p.receive(control('speakResult','voice-readback-a1',{text:'Pour tes factures, '+ANSWER.slice(0,40)}));
  assert.equal(acks(s).at(-1).state,'accepted');
 });

 await test('the readback text is never the app\'s, and stays bounded',()=>{
  const s=setup();open(s);
  s.p.receive(control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}));
  assert.equal(with_(s,'readbackRefused').at(-1).payload.readbackRefused.reason,'not_deferred');
  const long='Ta facture STEG est confirmée. '+'Voici le détail de chaque ligne de consommation et de chaque échéance. '.repeat(12);
  const text=deferredReadbackText({state:'done',text:long});
  assert.ok(text.length<=600);assert.ok(text.startsWith('Ta facture STEG est confirmée.'));assert.ok(text.endsWith('Le détail est dans la discussion.'));
  assert.equal(deferredReadbackText({state:'done',text:ANSWER,voice:{verbatim:ANSWER}}),ANSWER);
  assert.equal(deferredReadbackText({state:'done',text:'   '}),null);
 });

 await test('only the latest request stays due: each newer execution supersedes the earlier deferred answers',async()=>{
  const c=clock(),s=setup(c.now);const run=gatewayRun(c);
  for(const id of ['v1','v2','v3','v4']){
   open(s,id);s.p.provider({serverContent:{turnComplete:true}});
   await s.p.execute(id,REQUEST,async()=>({state:'pending',source:'samantha_brain',runId:'run-'+id,text:NOTICE}),{deferredReadback:true});
  }
  // Each execution is a newer request: earlier turns are superseded, so only the last one stays due.
  assert.deepEqual(with_(s,'deferredDropped').map(x=>[x.turnId,x.payload.deferredDropped.reason]),[['v1','superseded'],['v2','superseded'],['v3','superseded']]);
  assert.equal(s.p.deferredAlive('v4'),true);assert.equal(run.seen.polls,0);
 });

 await test('shared contract declares speakDeferred, its events, reasons and the opt-in',()=>{
  const sample=control('speakDeferred','voice-readback-1',{sourceTurnId:'voice-a'}).warmControl.speakDeferred;
  for(const field of contract.controls.speakDeferred)assert(field in sample,'speakDeferred.'+field);
  assert.equal(contract.optionalWarmReadyFields.deferredReadback,1);
  assert.equal(contract.deferredReadback.pendingNotice,NOTICE);assert.equal(brain.VOICE_PENDING_NOTICE,NOTICE);
  assert.deepEqual(contract.deferredReadback.refusalReasons.slice().sort(),['already_spoken','expired','not_admissible','not_deferred','nothing_due','superseded']);
  assert.deepEqual(contract.deferredReadback.dropReasons,['superseded','expired']);
  assert.equal(contract.deferredReadback.followHorizonMs,brain.VOICE_DEFERRED_FOLLOW_MS);
 });

 await test('Warm owner: announced to a v2 app, opt-in per turn, deferredReady reaches the app, readback reaches the provider',async()=>{
  class Provider extends EventEmitter {
   static instances=[];
   constructor(){super();this.readyState=0;this.sent=[];Provider.instances.push(this);setTimeout(()=>{this.readyState=1;this.emit('open')},1);}
   send(raw){const v=JSON.parse(raw);this.sent.push(v);if(v.setup)setTimeout(()=>this.emit('message',Buffer.from('{"setupComplete":{}}')),1);}
   close(){this.readyState=3;this.emit('close');}
  }
  Provider.OPEN=1;
  class Local extends EventEmitter {
   constructor(){super();this.readyState=1;this.messages=[];}
   send(raw){this.messages.push(JSON.parse(raw));}
   close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
  }
  const core=new ClawLiveWarmCore({tokenFactory:async()=>({token:'synthetic',setup:{model:'models/fixture'}}),WebSocketImpl:Provider,retryDelay:()=>0});
  const a=new Local();await core.attach(a,{locale:'fr',client:'samantha_android',sessionId:'samantha-05fdeb6c',protocol:2,sessionEpoch:'epoch-a'});
  const ready=a.messages.find(v=>v.warmReady).warmReady;assert.equal(ready.deferredReadback,1);
  const send=v=>a.emit('message',Buffer.from(JSON.stringify(v)));
  const ctl=(kind,body)=>({warmControl:{[kind]:{operationId:kind+'-'+(body.turnId||'x'),sessionEpoch:'epoch-a',...body}}});
  send(ctl('turnStart',{turnId:'voice-a',firstSample:0}));send(ctl('turnEnd',{turnId:'voice-a',lastSampleExclusive:0}));
  send(ctl('transcriptFinal',{turnId:'voice-a',source:'android_speech_service',text:REQUEST}));
  const provider=Provider.instances.at(-1);provider.emit('message',Buffer.from('{"serverContent":{"turnComplete":true}}'));
  const meta={sessionEpoch:'epoch-a',connectionEpoch:ready.connectionEpoch,turnId:'voice-a'};
  assert.equal(core.voiceDeferredOwner(meta),undefined,'no opt-in, no deferred owner');
  const owner=core.voiceDeferredOwner({...meta,deferredReadback:1});assert.equal(typeof owner.settle,'function');
  await core.executeVoiceCapability({...meta,deferredReadback:1},REQUEST,async()=>({success:true,state:'pending',source:'samantha_brain',runId:RUN,text:NOTICE,voice:{version:1,phase:'failure',verbatim:NOTICE}}));
  assert.equal(owner.alive(),true);
  owner.settle({success:true,state:'done',source:'samantha_brain',runId:RUN,text:ANSWER,voice:{version:1,phase:'none',verbatim:ANSWER}});
  assert.ok(a.messages.some(v=>v.warmEvent?.payload?.deferredReady&&v.warmEvent.turnId==='voice-a'));
  send(ctl('speakDeferred',{turnId:'voice-readback-1',sourceTurnId:'voice-a'}));
  const readback=provider.sent.at(-1).clientContent.turns[0].parts[0].text;assert.ok(readback.endsWith(JSON.stringify(ANSWER)));
  assert.equal(owner.alive(),false,'spoken: the owner no longer wants it');
  a.close();core.shutdown();
 });

 console.log(JSON.stringify({passed,failed:0,fixture:'s24-2026-10-30-voice-slow-brain',live:'not_run (no S24 write during the voice bench; paired app change pending)'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
