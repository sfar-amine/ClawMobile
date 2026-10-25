const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {VoiceTurnProtocol}=require('../dist/companion/voiceTurnProtocol.js');
const contract=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/protocol/voice-v2-app-companion.json'),'utf8'));
let passed=0;
const observedCorrelations=new Set();
function test(name,run){return Promise.resolve().then(run).then(()=>{passed++;console.log('PASS '+name);});}
function setup(){const sent=[],events=[];return {sent,events,p:new VoiceTurnProtocol(1,'session-1',v=>sent.push(v),v=>{if(v.warmEvent)observedCorrelations.add(v.warmEvent.correlation);events.push(v);})};}
function control(kind,turn,extra={}){return {warmControl:{[kind]:{operationId:kind+'-'+turn,sessionEpoch:'session-1',turnId:turn,...extra}}};}
function start(s,id='voice-a',first=0){s.p.receive(control('turnStart',id,{firstSample:first}));}
function audio(s,id='voice-a',first=0,n=320,value=0){s.p.receive({warmInput:{audio:{turnId:id,sessionEpoch:'session-1',firstSample:first,samples:n,sampleRate:16000,data:Buffer.alloc(n*2,value).toString('base64')}}});}
function end(s,id='voice-a',last=320){s.p.receive(control('turnEnd',id,{lastSampleExclusive:last}));}
function finishAsr(s,text='Bonjour',id='voice-a'){s.p.receive(control('transcriptFinal',id,{source:'android_speech_service',text}));}
function error(s){return s.events.flatMap(x=>x.warmEvent?.payload?.protocolError?.code||[]);}
(async()=>{
 await test('Android and Companion share every v2 envelope',()=>{const samples={
  speakFirst:control('speakFirst','greeting'),speakResult:control('speakResult','readback-1',{text:'Pour la facture, elle est payée.'}),speakProgress:control('speakProgress','voice-a',{text:'Je regarde la météo de Tunis pour demain.'}),turnStart:control('turnStart','voice-a',{firstSample:0}),
  turnEnd:control('turnEnd','voice-a',{lastSampleExclusive:320}),
  transcriptFinal:control('transcriptFinal','voice-a',{source:'android_speech_service',text:'Bonjour'}),
  interrupt:control('interrupt','voice-a',{outputGenerationId:'out-voice-a'})};
  for(const [kind,message] of Object.entries(samples)){const body=message.warmControl[kind];for(const field of contract.controls[kind])assert(field in body,`${kind}.${field}`);}
  const receipt={warmControl:{receiptReply:{turnId:'voice-a'}}};for(const field of contract.controls.receiptReply)assert(field in receipt.warmControl.receiptReply,`receiptReply.${field}`);
  const frame={warmInput:{audio:{sessionEpoch:'session-1',turnId:'voice-a',firstSample:0,samples:320,sampleRate:16000,data:Buffer.alloc(640).toString('base64')}}};
  for(const field of contract.audio)assert(field in frame.warmInput.audio,`audio.${field}`);
  const s=setup();start(s);const event=s.events.find(v=>v.warmEvent?.payload?.turnAdmitted);
  for(const field of contract.warmEvent)assert(field in event.warmEvent,`warmEvent.${field}`);
 });
 await test('duplex greeting is correlated, once and never executable',async()=>{const s=setup(),m=control('speakFirst','greeting');s.p.receive(m);s.p.receive(m);assert.equal(s.sent.length,1);assert(s.sent[0].clientContent.turnComplete);s.p.provider({serverContent:{outputTranscription:{text:'Bonjour'},turnComplete:true}});assert.equal(s.events.find(x=>x.warmEvent?.payload?.serverContent)?.warmEvent.turnId,'greeting');assert.throws(()=>s.p.execute('greeting','',async()=>1));start(s);audio(s);end(s);finishAsr(s);assert.deepEqual(error(s),[]);});
 await test('greeting cannot request a tool or replace a user turn',()=>{const s=setup();s.p.receive(control('speakFirst','greeting'));s.p.provider({toolCall:{functionCalls:[{id:'unsafe',name:'ask_samantha',args:{request:'do it'}}]}});assert.deepEqual(error(s),[]);assert(!s.events.some(x=>x.warmEvent?.payload?.toolCall));const refused=s.sent.at(-1).toolResponse.functionResponses[0];assert.equal(refused.id,'unsafe');assert.equal(refused.response.error,'not_admissible');assert.equal(refused.response.reason,'greeting');s.p.provider({serverContent:{outputTranscription:{text:'Bonjour'},turnComplete:true}});start(s);audio(s);end(s);finishAsr(s);assert.deepEqual(error(s),[]);const t=setup();start(t);t.p.receive(control('speakFirst','late-greeting'));assert(error(t).includes('greeting_not_admissible'));});
 await test('readback is spoken verbatim, once, only when nobody speaks',()=>{const s=setup();start(s);audio(s);end(s);finishAsr(s);s.p.provider({serverContent:{turnComplete:true}});const before=s.sent.length;const m=control('speakResult','readback-1',{text:'Pour la facture, elle est payée.'});s.p.receive(m);s.p.receive(m);assert.equal(s.sent.length,before+1);const said=s.sent.at(-1).clientContent.turns[0].parts[0].text;assert(said.startsWith('Read exactly'));assert(said.endsWith(JSON.stringify('Pour la facture, elle est payée.')));assert(s.events.some(x=>x.warmEvent?.payload?.readbackAdmitted&&x.warmEvent.turnId==='readback-1'));assert.deepEqual(error(s),[]);});
 await test('readback is refused, without breaking the session, while Amine speaks or Samantha answers',()=>{const refused=s=>s.events.filter(x=>x.warmEvent?.payload?.readbackRefused).length;const s=setup();start(s);const n=s.sent.length;s.p.receive(control('speakResult','readback-1',{text:'x'}));assert.equal(refused(s),1);assert.equal(s.sent.length,n);assert.equal(s.events.find(x=>x.warmAck?.operationId==='speakResult-readback-1').warmAck.state,'refused');audio(s);end(s);finishAsr(s);assert.deepEqual(error(s),[]);const t=setup();start(t);audio(t);end(t);finishAsr(t);t.p.receive(control('speakResult','readback-2',{text:'x'}));assert.equal(refused(t),1);t.p.provider({serverContent:{turnComplete:true}});t.p.receive(control('speakResult','readback-3',{text:'Pour X, c est fait.'}));assert(t.events.some(x=>x.warmEvent?.payload?.readbackAdmitted&&x.warmEvent.turnId==='readback-3'));assert.deepEqual(error(t),[]);});
 await test('readback can never execute or call a tool',()=>{const s=setup();s.p.receive(control('speakResult','readback-1',{text:'Pour X, c est fait.'}));assert.throws(()=>s.p.execute('readback-1','',async()=>1));s.p.provider({toolCall:{functionCalls:[{id:'unsafe',name:'ask_samantha',args:{request:'paye'}}]}});assert.deepEqual(error(s),[]);assert(!s.events.some(x=>x.warmEvent?.payload?.toolCall));assert.equal(s.sent.at(-1).toolResponse.functionResponses[0].response.reason,'readback');});
 await test('new speech interrupts a readback',()=>{const s=setup();s.p.receive(control('speakResult','readback-1',{text:'Pour X, c est fait.'}));start(s);assert(s.events.some(x=>x.warmEvent?.payload?.turnPending?.reason==='output_boundary'));assert.deepEqual(error(s),[]);});
 await test('readback text is bounded',()=>{const s=setup();s.p.receive(control('speakResult','readback-1',{text:'x'.repeat(601)}));assert(error(s).includes('invalid_readback_text'));const t=setup();t.p.receive(control('speakResult','readback-1',{text:'  '}));assert(error(t).includes('invalid_readback_text'));});
 await test('start/end replay is idempotent',()=>{const s=setup();start(s);start(s);audio(s);audio(s);end(s);end(s);assert.equal(s.sent.length,3);assert.deepEqual(error(s),[]);});
 await test('sample discontinuity is fatal, not a truncated request',async()=>{const s=setup();start(s);audio(s,'voice-a',20);end(s);finishAsr(s);assert(error(s).includes('noncontiguous_input'));assert.throws(()=>s.p.execute('voice-a','Bonjour',async()=>1));assert.equal(s.sent.length,1);});
 await test('conflicting audio retry is never forwarded',()=>{const s=setup();start(s);audio(s);audio(s,'voice-a',0,320,1);assert(error(s).includes('audio_identity_conflict'));assert.equal(s.sent.length,2);});
 await test('next input waits for on-device final transcript and output boundary',()=>{const s=setup();start(s);audio(s);end(s);start(s,'voice-b',4800);assert.equal(s.sent.filter(v=>v.realtimeInput?.activityStart).length,1);s.p.provider({serverContent:{inputTranscription:{text:'provider only',finished:true}}});assert.equal(s.sent.filter(v=>v.realtimeInput?.activityStart).length,1);finishAsr(s,'Bonjour');assert.equal(s.sent.filter(v=>v.realtimeInput?.activityStart).length,2);assert(s.events.some(x=>x.warmEvent?.payload?.turnPending?.turnId==='voice-b'));assert(!s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));s.p.provider({serverContent:{interrupted:true}});assert(s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));});
 await test('an unanswered turn never holds the next one: bounded boundary, stale tail dropped (S24 18/10 15:38)',async()=>{
  const timers=[],sent=[],events=[];const s={sent,events,p:new VoiceTurnProtocol(1,'session-1',v=>sent.push(v),v=>events.push(v),undefined,undefined,false,(run,ms)=>{timers.push({run,ms});return 0;})};
  start(s);audio(s);end(s);finishAsr(s,'bonjour j aimerais avoir');
  start(s,'voice-b',4800);assert(s.events.some(x=>x.warmEvent?.payload?.turnPending?.turnId==='voice-b'));
  assert(!s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));assert.equal(timers.at(-1).ms,2000);
  timers.at(-1).run();assert(s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));
  assert.equal(s.sent.filter(v=>v.realtimeInput?.activityStart).length,2);
  s.p.provider({serverContent:{interrupted:true}});s.p.provider({serverContent:{modelTurn:{parts:[{text:'reponse a la premiere moitie'}]}}});
  assert(!s.events.some(x=>x.warmEvent?.turnId==='voice-b'&&x.warmEvent?.payload?.serverContent));
  audio(s,'voice-b',4800);end(s,'voice-b',5120);finishAsr(s,'mon solde orange','voice-b');assert.deepEqual(error(s),[]);
  assert.equal(await s.p.execute('voice-b','mon solde orange',async()=>'ok'),'ok');
 });
 await test('a turn that already answered keeps waiting for the provider boundary',()=>{
  const timers=[];const s={sent:[],events:[]};s.p=new VoiceTurnProtocol(1,'session-1',v=>s.sent.push(v),v=>s.events.push(v),undefined,undefined,false,(run,ms)=>{timers.push({run,ms});return 0;});
  start(s);audio(s);end(s);finishAsr(s,'Bonjour');s.p.provider({serverContent:{modelTurn:{parts:[{text:'Bonjour Amine'}]}}});
  start(s,'voice-b',4800);timers.at(-1).run();assert(!s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));
  s.p.provider({serverContent:{interrupted:true}});assert(s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));assert.deepEqual(error(s),[]);
 });
 await test('provider transcript cannot authorize execution',()=>{const s=setup();start(s);audio(s);end(s);s.p.provider({serverContent:{inputTranscription:{text:'Bonjour',finished:true}}});assert(s.p.snapshot().asrPending);assert.throws(()=>s.p.execute('voice-a','Bonjour',async()=>1));assert.deepEqual(error(s),[]);});
 await test('a window with no speech closes as empty input and admits the next turn',()=>{
  // S24 18/10 12:35: a VAD blip opened a turn, the recognizer heard nothing, and nothing could close the turn.
  const noSpeech=(s,id='voice-a')=>s.p.receive(control('transcriptFinal',id,{source:'android_speech_service',text:'',noSpeech:true}));
  const s=setup();start(s);audio(s);end(s);s.p.provider({toolCall:{functionCalls:[{id:'fc1',name:'clawmobile_capability',args:{request:'paye'}}]}});
  start(s,'voice-b',4800);assert(!s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));
  noSpeech(s);
  const final=s.events.find(x=>x.warmEvent?.payload?.inputFinal);assert.deepEqual(final.warmEvent.payload.inputFinal,{text:'',source:'android_speech_service',noSpeech:true});
  assert(!s.events.some(x=>x.warmEvent?.payload?.toolCall),'a held tool call of a silent window is never released');
  assert.throws(()=>s.p.execute('voice-a','',async()=>1));assert.throws(()=>s.p.execute('voice-a','paye',async()=>1));
  assert(!s.p.snapshot().asrPending);assert.deepEqual(error(s),[]);
  s.p.provider({serverContent:{interrupted:true}});assert(s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));
  audio(s,'voice-b',4800);end(s,'voice-b',5120);finishAsr(s,'Bonjour','voice-b');assert.deepEqual(error(s),[]);
 });
 await test('an empty transcript needs the explicit no-speech flag, and the flag never carries text',()=>{
  const a=setup();start(a);audio(a);end(a);finishAsr(a,'  ');assert(error(a).includes('invalid_transcript_text'));
  const b=setup();start(b);audio(b);end(b);b.p.receive(control('transcriptFinal','voice-a',{source:'android_speech_service',text:'paye',noSpeech:true}));assert(error(b).includes('invalid_transcript_text'));
  const c=setup();start(c);audio(c);end(c);c.p.receive(control('transcriptFinal','voice-a',{source:'android_speech_service',text:'',noSpeech:'true'}));assert(error(c).includes('invalid_transcript_text'));
  assert.deepEqual(contract.optionalControlFields.transcriptFinal,['noSpeech']);
 });
 await test('a provider tool call nobody may run is refused to the provider, never fatal, and bounded',()=>{
  // S24 18/10 13:09: a tool call during the greeting ended the call before Amine said a word.
  const s=setup();s.p.provider({toolCall:{functionCalls:[{id:'orphan',name:'clawmobile_capability',args:{request:'x'}}]}});
  assert.deepEqual(error(s),[]);assert.equal(s.sent.at(-1).toolResponse.functionResponses[0].response.reason,'no_active_turn');
  s.p.provider({serverContent:{outputTranscription:{text:'late tail'},turnComplete:true}});assert.deepEqual(error(s),[]);assert(!s.events.some(x=>x.warmEvent?.payload?.serverContent));
  start(s);audio(s);end(s);finishAsr(s);assert.deepEqual(error(s),[]);
  const t=setup();t.p.receive(control('speakFirst','greeting'));
  for(let i=0;i<16;i++)t.p.provider({toolCall:{functionCalls:[{id:'g'+i,name:'ask_samantha',args:{}}]}});assert.deepEqual(error(t),[]);
  t.p.provider({toolCall:{functionCalls:[{id:'g16',name:'ask_samantha',args:{}}]}});assert(error(t).includes('provider_tool_refusal_budget'));
 });
 await test('tools await on-device final transcript',()=>{const s=setup();start(s);audio(s);end(s);s.p.provider({toolCall:{functionCalls:[{id:'fc1',name:'clawmobile_capability',args:{request:'Bonjour'}}]}});assert(!s.events.some(x=>x.warmEvent?.payload?.toolCall));finishAsr(s);assert(s.events.some(x=>x.warmEvent?.payload?.toolCall));});
 await test('execution is exactly once for the admitted turn',async()=>{const s=setup();start(s);audio(s);end(s);finishAsr(s);let count=0;const run=()=>{count++;return Promise.resolve({ok:true});};const a=s.p.execute('voice-a','Bonjour',run),b=s.p.execute('voice-a','Bonjour',run);assert.equal(a,b);await a;assert.equal(count,1);assert.throws(()=>s.p.execute('voice-a','Other',run));});
 await test('receipt reply is accepted only after the correlated execution and generation end',async()=>{const s=setup();start(s);audio(s);end(s);finishAsr(s);await s.p.execute('voice-a','Bonjour',async()=>({execution:{state:'completed'}}));s.p.receive({warmControl:{receiptReply:{turnId:'voice-a'}}});assert.deepEqual(error(s),[]);assert(s.events.some(x=>x.warmEvent?.payload?.receiptRefused?.reason==='output_open'));const t=setup();start(t);audio(t);end(t);finishAsr(t);await t.p.execute('voice-a','Bonjour',async()=>({execution:{state:'completed'}}));t.p.provider({serverContent:{turnComplete:true}});t.p.receive({warmControl:{receiptReply:{turnId:'voice-a'}}});assert(t.events.some(x=>x.warmEvent?.payload?.outputResumed));assert.equal(t.sent.filter(x=>x.clientContent?.turnComplete).length,1);});
 await test('interruption preserves admitted execution but rejects new old-turn execution',async()=>{const s=setup();start(s);audio(s);end(s);finishAsr(s);let complete;const execution=s.p.execute('voice-a','Bonjour',()=>new Promise(r=>complete=r));await Promise.resolve();s.p.receive(control('interrupt','voice-a',{outputGenerationId:'out-voice-a'}));complete({done:true});assert.deepEqual(await execution,{done:true});const t=setup();start(t);audio(t);end(t);finishAsr(t);t.p.receive(control('interrupt','voice-a',{outputGenerationId:'out-voice-a'}));assert.throws(()=>t.p.execute('voice-a','Bonjour',async()=>1));});
 await test('late tool from interrupted generation is not exposed',()=>{const s=setup();start(s);audio(s);end(s);finishAsr(s);s.p.receive(control('interrupt','voice-a',{outputGenerationId:'out-voice-a'}));start(s,'voice-b',5000);s.p.provider({toolCall:{functionCalls:[{id:'late',name:'clawmobile_capability',args:{request:'Bonjour'}}]}});assert(!s.events.some(x=>x.warmEvent?.payload?.toolCall));});
 await test('output crosses turns only at provider completion',()=>{const s=setup();start(s);audio(s);end(s);finishAsr(s);start(s,'voice-b',5000);s.p.provider({serverContent:{interrupted:true,turnComplete:true}});audio(s,'voice-b',5000);end(s,'voice-b',5320);s.p.provider({serverContent:{outputTranscription:{text:'new'}}});const e=s.events.filter(x=>x.warmEvent?.payload?.serverContent?.outputTranscription).at(-1);assert.equal(e.warmEvent.turnId,'voice-b');});
 await test('metadata never reaches provider payload',()=>{const s=setup();start(s);audio(s);end(s);finishAsr(s);assert(!JSON.stringify(s.sent).includes('sessionEpoch'));assert(!JSON.stringify(s.sent).includes('turnId'));assert(!JSON.stringify(s.sent).includes('android_speech_service'));});
 await test('new provider generation cannot be opened by raw client content',()=>{const s=setup();s.p.receive({clientContent:{turnComplete:true,turns:[]}});assert.equal(s.sent.length,0);assert(error(s).includes('unsupported_v2_message'));});
 await test('provider finished marker before input end does not close local ASR',()=>{const s=setup();start(s);s.p.provider({serverContent:{inputTranscription:{text:'oui',finished:true}}});assert(s.p.snapshot().asrPending);assert.deepEqual(error(s),[]);});
 await test('transcript final must follow turn end',()=>{const s=setup();start(s);finishAsr(s);assert(error(s).includes('invalid_transcript_final'));});
 await test('every emitted correlation is declared by the shared contract',()=>{
  const s=setup();s.p.provider({serverContent:{inputTranscription:{text:'Synthetic late input'}}});
  assert.equal(contract.correlation.unknown,'fatal');
  assert.deepEqual([...observedCorrelations].sort(),[...contract.correlation.values].sort());
 });
 await test('a receipt reply without admitted execution is refused for its turn, never a session error (banc voix 18/10)',()=>{const s=setup();start(s);audio(s);end(s);finishAsr(s);s.p.provider({serverContent:{turnComplete:true}});s.p.receive({warmControl:{receiptReply:{turnId:'voice-a'}}});assert.deepEqual(error(s),[]);const refused=s.events.find(x=>x.warmEvent?.payload?.receiptRefused);assert.equal(refused.warmEvent.payload.receiptRefused.reason,'no_execution');assert.equal(refused.warmEvent.turnId,'voice-a');assert(!s.sent.some(x=>x.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('Verified receipt')));start(s,'voice-b',320);audio(s,'voice-b',320);assert.deepEqual(error(s),[]);assert(s.events.some(x=>x.warmEvent?.payload?.turnAdmitted&&x.warmEvent.turnId==='voice-b'));});
 // Live progress of a brain turn (Amine 25/10/2026): user-oriented lines read verbatim while the execution runs.
 const ASK='Quel temps fera-t-il demain à Tunis ?';
 async function brainTurn(observer){const sent=[],events=[];const s={sent,events,p:new VoiceTurnProtocol(1,'session-1',v=>sent.push(v),v=>events.push(v),observer)};
  start(s);audio(s);end(s);finishAsr(s,ASK);let complete;const exec=s.p.execute('voice-a',ASK,()=>new Promise(r=>complete=r));await Promise.resolve();await Promise.resolve();
  s.p.provider({serverContent:{turnComplete:true}});return {s,exec,complete:v=>complete(v)};}
 const progress=(s,n,text='Je regarde la météo de Tunis pour demain.',turn='voice-a')=>s.p.receive(control('speakProgress',turn,{operationId:'speakProgress-'+turn+'-'+n,text}));
 const ack=(s,n,turn='voice-a')=>s.events.find(x=>x.warmAck?.operationId==='speakProgress-'+turn+'-'+n)?.warmAck.state;
 const refusals=s=>s.events.flatMap(x=>x.warmEvent?.payload?.progressRefused?.reason||[]);
 await test('progress is spoken verbatim on the same turn while its execution runs',async()=>{
  const {s}=await brainTurn();const before=s.sent.length;progress(s,1);progress(s,1);
  assert.equal(ack(s,1),'accepted');assert.equal(s.sent.length,before+1,'an exact replay is answered from the ledger, never spoken twice');
  const said=s.sent.at(-1).clientContent.turns[0].parts[0].text;assert(said.startsWith('Read exactly'));assert(said.includes('Do not call any tool'));
  assert(said.endsWith(JSON.stringify('Je regarde la météo de Tunis pour demain.')));
  const resumed=s.events.find(x=>x.warmEvent?.payload?.outputResumed?.progress);assert.equal(resumed.warmEvent.turnId,'voice-a');assert.equal(resumed.warmEvent.outputGenerationId,'out-voice-a-progress-1');
  s.p.provider({serverContent:{outputTranscription:{text:'Je regarde'},turnComplete:true}});
  assert.equal(s.events.filter(x=>x.warmEvent?.payload?.serverContent).at(-1).warmEvent.outputGenerationId,'out-voice-a-progress-1');
  progress(s,2,'J ai trouvé les prévisions, je les résume.');assert.equal(ack(s,2),'accepted');
  assert(s.events.some(x=>x.warmEvent?.outputGenerationId==='out-voice-a-progress-2'));assert.deepEqual(error(s),[]);
 });
 await test('progress is refused for its turn, never a session error, outside a running brain execution',async()=>{
  // No execution admitted for the turn.
  const a=setup();start(a);audio(a);end(a);finishAsr(a,ASK);a.p.provider({serverContent:{turnComplete:true}});progress(a,1);assert.deepEqual(refusals(a),['not_admissible']);assert.equal(ack(a,1),'refused');
  // The result is already there: the receipt reply speaks it, not a progress line.
  const b=await brainTurn();b.complete({execution:{state:'completed'}});await b.exec;progress(b.s,1);assert.deepEqual(refusals(b.s),['not_admissible']);
  // The turn's own output is still open (the waiting sentence has not ended).
  const c=setup();start(c);audio(c);end(c);finishAsr(c,ASK);c.p.execute('voice-a',ASK,()=>new Promise(()=>{}));await Promise.resolve();progress(c,1);assert.deepEqual(refusals(c),['not_admissible']);
  // Greeting and deferred readback turns never carry progress.
  const d=setup();d.p.receive(control('speakFirst','greeting'));d.p.provider({serverContent:{turnComplete:true}});progress(d,1,'x','greeting');assert.deepEqual(refusals(d),['not_admissible']);
  const e=setup();e.p.receive(control('speakResult','readback-1',{text:'Pour X, c est fait.'}));e.p.provider({serverContent:{turnComplete:true}});progress(e,1,'x','readback-1');assert.deepEqual(refusals(e),['not_admissible']);
  // An interrupted turn stays silent.
  const f=await brainTurn();f.s.p.receive(control('interrupt','voice-a',{outputGenerationId:'out-voice-a'}));progress(f.s,1);assert.deepEqual(refusals(f.s),['not_admissible']);
  // Amine is speaking: his new turn owns the floor.
  const g=await brainTurn();start(g.s,'voice-b',320);progress(g.s,1);assert.deepEqual(refusals(g.s),['not_admissible']);
  for(const x of [a,b.s,c,d,e,f.s,g.s])assert.deepEqual(error(x),[]);
 });
 await test('progress text and count are bounded, as explicit refusals',async()=>{
  const {s}=await brainTurn();progress(s,1,'   ');progress(s,2,'x'.repeat(201));assert.deepEqual(refusals(s),['invalid_text','invalid_text']);
  for(let n=3;n<9;n++){progress(s,n,'Étape '+n);assert.equal(ack(s,n),'accepted');s.p.provider({serverContent:{turnComplete:true}});}
  progress(s,9,'Étape 9');assert.deepEqual(refusals(s).slice(-1),['progress_budget']);assert.equal(ack(s,9),'refused');
  assert.equal(s.events.filter(x=>x.warmEvent?.payload?.outputResumed?.progress).length,6);assert.deepEqual(error(s),[]);
  progress(s,10,'x'.repeat(200));assert.deepEqual(refusals(s).slice(-1),['progress_budget']);
  assert.deepEqual(contract.speakProgress.refusalReasons.sort(),['invalid_text','not_admissible','progress_budget']);
  assert.equal(contract.speakProgress.maxChars,200);assert.equal(contract.speakProgress.maxPerTurn,6);
 });
 await test('a provider tool call during a progress line is refused, never a second execution',async()=>{
  const {s}=await brainTurn();progress(s,1);const exposed=s.events.filter(x=>x.warmEvent?.payload?.toolCall).length;
  s.p.provider({toolCall:{functionCalls:[{id:'again',name:'ask_samantha',args:{request:ASK}}]}});
  assert.equal(s.events.filter(x=>x.warmEvent?.payload?.toolCall).length,exposed);
  const refused=s.sent.at(-1).toolResponse.functionResponses[0];assert.equal(refused.id,'again');assert.equal(refused.response.reason,'progress_readback');assert.deepEqual(error(s),[]);
 });
 await test('the receipt reply still works once the last progress line has ended',async()=>{
  const {s,exec,complete}=await brainTurn();progress(s,1);complete({execution:{state:'completed'},voice:{verbatim:'Demain à Tunis, 24 degrés et du soleil.'}});await exec;
  s.p.receive({warmControl:{receiptReply:{turnId:'voice-a'}}});assert(s.events.some(x=>x.warmEvent?.payload?.receiptRefused?.reason==='output_open'));
  s.p.provider({serverContent:{turnComplete:true}});s.p.receive({warmControl:{receiptReply:{turnId:'voice-a'}}});
  const resumed=s.events.filter(x=>x.warmEvent?.payload?.outputResumed).at(-1);assert.equal(resumed.warmEvent.outputGenerationId,'out-voice-a-receipt');
  assert(s.sent.at(-1).clientContent.turns[0].parts[0].text.includes('Demain à Tunis, 24 degrés et du soleil.'));assert.deepEqual(error(s),[]);
 });
 await test('new speech interrupts a progress line and silences the rest of that turn',async()=>{
  const {s}=await brainTurn();progress(s,1);start(s,'voice-b',320);
  assert(s.events.some(x=>x.warmEvent?.payload?.turnPending?.reason==='output_boundary'));
  s.p.provider({serverContent:{interrupted:true}});assert(s.events.some(x=>x.warmEvent?.payload?.turnAdmitted?.turnId==='voice-b'));
  progress(s,2);assert.deepEqual(refusals(s),['not_admissible']);s.p.receive({warmControl:{receiptReply:{turnId:'voice-a'}}});
  assert(s.events.some(x=>x.warmEvent?.payload?.receiptRefused?.reason==='interrupted'));assert.deepEqual(error(s),[]);
 });
 await test('a progress line is measured as its own phase, not as the turn response time',async()=>{
  const seen=[];const {s}=await brainTurn((event,turn,metadata)=>{if(event==='t30p')seen.push(metadata);});
  progress(s,1);s.p.provider({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AAAA'}}]}}});
  assert.equal(seen.length,1);assert.equal(seen[0].phase,2);assert(!('gemini_ms' in seen[0]));assert(!('response_ms' in seen[0]));
 });
 console.log(JSON.stringify({passed,failed:0,scope:'deterministic_protocol_not_acoustic',boundary:'android_on_device_final'}));
})().catch(e=>{console.error(e);process.exitCode=1});
