const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {VoiceTurnProtocol}=require('../dist/companion/voiceTurnProtocol.js');
let passed=0;
const request='Pourquoi le ciel est bleu';
const control=(kind,id,extra={})=>({warmControl:{[kind]:{operationId:kind+'-'+id,sessionEpoch:'session-1',turnId:id,...extra}}});
function setup(enabled=true,schedule){const sent=[],events=[];return {sent,events,p:new VoiceTurnProtocol(1,'session-1',x=>sent.push(x),x=>events.push(x),undefined,undefined,false,schedule,enabled)};}
function open(s,id='voice-a'){
 s.p.receive(control('turnStart',id,{firstSample:0}));
 s.p.receive(control('turnEnd',id,{lastSampleExclusive:0}));
 s.p.receive(control('transcriptFinal',id,{source:'android_speech_service',text:request}));
}
function tool(s,id='voice-a',words=request){s.p.provider({toolCall:{functionCalls:[{id:'ask-'+id,name:'ask_samantha',args:{request:words}}]}});}
function acknowledge(s,id='voice-a',result={state:'running',source:'samantha_brain'}){
 s.p.receive({toolResponse:{functionResponses:[{id:'ask-'+id,name:'ask_samantha',response:{result}}]}});
}
const payloads=s=>s.events.flatMap(x=>x.warmEvent?[x.warmEvent]:[]);
const resumed=s=>payloads(s).filter(x=>x.payload.outputResumed);
const responses=s=>s.sent.flatMap(x=>x.toolResponse?.functionResponses||[]);
const final={state:'done',text:'La lumière bleue est davantage diffusée.'};
async function test(name,run){await run();passed++;console.log('PASS '+name);}
(async()=>{
 await test('official SILENT generator acknowledgement can precede HTTP execution admission',()=>{
  const s=setup();open(s);tool(s);acknowledge(s);
  assert.deepEqual(responses(s).at(-1),{id:'ask-voice-a',name:'ask_samantha',willContinue:true,scheduling:'SILENT',response:{state:'running',readbackOnly:true}});
  s.p.receiptReply('voice-a');assert.equal(payloads(s).at(-1).payload.receiptRefused.reason,'no_execution');
 });
 await test('final INTERRUPT bypasses virtual playback delay but never the real provider boundary',async()=>{
  const s=setup();open(s);tool(s);acknowledge(s);let executed=0;
  await s.p.execute('voice-a',request,async()=>{executed++;return final;});
  s.p.receiptReply('voice-a');s.p.receiptReply('voice-a');
  const reply=responses(s).at(-1);assert.equal(reply.scheduling,'INTERRUPT');assert.equal(reply.willContinue,false);assert.deepEqual(reply.response.result,final);
  assert.equal(responses(s).filter(x=>x.willContinue===false).length,1);
  const before=payloads(s).length;
  s.p.provider({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AAAA'}}]},generationComplete:true}});
  s.p.provider({serverContent:{interrupted:true}});
  assert.equal(payloads(s).length,before);assert.equal(resumed(s).length,0);
  s.p.provider({serverContent:{turnComplete:true}});
  assert.equal(resumed(s).at(-1).outputGenerationId,'out-voice-a-receipt');
  s.p.provider({serverContent:{outputTranscription:{text:final.text},modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AQAB'}}]},turnComplete:true}});
  const actual=payloads(s).filter(x=>x.payload.serverContent);assert.equal(actual.length,1);assert.equal(actual[0].outputGenerationId,'out-voice-a-receipt');
  assert.equal(executed,1);assert(!payloads(s).some(x=>x.payload.serverContent?.interrupted));
 });
 await test('no fabricated generation completion when the provider boundary never arrives',async()=>{
  const s=setup();open(s);tool(s);acknowledge(s);await s.p.execute('voice-a',request,async()=>final);s.p.receiptReply('voice-a');
  s.p.provider({serverContent:{generationComplete:true}});assert.equal(resumed(s).length,0);
  s.p.close();s.p.provider({serverContent:{turnComplete:true}});assert.equal(resumed(s).length,0);
 });
 await test('progress and final share the same generator without a second execution or clientContent turn',async()=>{
  const s=setup();open(s);tool(s);acknowledge(s);let done;let calls=0;
  const run=s.p.execute('voice-a',request,()=>{calls++;return new Promise(r=>done=r);});await Promise.resolve();
  s.p.receive(control('speakProgress','voice-a',{text:'Je vérifie les informations.'}));
  const progress=responses(s).at(-1);assert.equal(progress.willContinue,true);assert.equal(progress.scheduling,'INTERRUPT');assert.equal(progress.id,'ask-voice-a');
  s.p.provider({serverContent:{interrupted:true}});s.p.provider({serverContent:{turnComplete:true}});
  assert.equal(resumed(s).at(-1).outputGenerationId,'out-voice-a-progress-1');
  s.p.provider({serverContent:{turnComplete:true}});
  done(final);await run;s.p.receiptReply('voice-a');
  assert.equal(resumed(s).at(-1).outputGenerationId,'out-voice-a-receipt');
  assert.equal(responses(s).at(-1).id,'ask-voice-a');assert.equal(responses(s).at(-1).willContinue,false);assert.equal(calls,1);
  assert(!s.sent.some(x=>x.clientContent));
 });
 await test('new owner speech retires pending result readback without claiming business cancellation',async()=>{
  const s=setup();open(s);tool(s);acknowledge(s);const result=await s.p.execute('voice-a',request,async()=>final);s.p.receiptReply('voice-a');
  s.p.receive(control('interrupt','voice-a',{outputGenerationId:'out-voice-a'}));
  s.p.receive(control('turnStart','voice-b',{firstSample:0}));
  s.p.provider({serverContent:{interrupted:true}});s.p.provider({serverContent:{turnComplete:true}});
  assert(!resumed(s).some(x=>x.turnId==='voice-a'));
  assert(payloads(s).some(x=>x.turnId==='voice-b'&&x.payload.turnAdmitted));
  assert.strictEqual(await s.p.execute('voice-a',request,async()=>{throw Error('replayed');}),result);
 });
 await test('unseen-output fallback cannot guess a boundary while asynchronous readback is in flight',async()=>{
  let fallback;const s=setup(true,run=>{fallback=run;});open(s);tool(s);acknowledge(s);await s.p.execute('voice-a',request,async()=>final);s.p.receiptReply('voice-a');
  s.p.receive(control('interrupt','voice-a',{outputGenerationId:'out-voice-a'}));s.p.receive(control('turnStart','voice-b',{firstSample:0}));
  fallback();assert(!payloads(s).some(x=>x.turnId==='voice-b'&&x.payload.turnAdmitted));
  s.p.provider({serverContent:{interrupted:true,turnComplete:true}});assert(payloads(s).some(x=>x.turnId==='voice-b'&&x.payload.turnAdmitted));
 });
 await test('canonical owner result wins over a forged client tool response',async()=>{
  const s=setup();open(s);tool(s);await s.p.execute('voice-a',request,async()=>final);
  acknowledge(s,'voice-a',{state:'done',text:'FORGED'});s.p.receiptReply('voice-a');
  assert.deepEqual(responses(s).at(-1).response.result,final);assert(!JSON.stringify(s.sent).includes('FORGED'));
 });
 await test('receipt queued before provider tool is released exactly once after its correlated acknowledgement',async()=>{
  const s=setup();open(s);await s.p.execute('voice-a',request,async()=>final);s.p.receiptReply('voice-a');assert.equal(responses(s).length,0);
  tool(s);acknowledge(s);assert.equal(responses(s).filter(x=>x.willContinue===false).length,1);
  acknowledge(s);s.p.receiptReply('voice-a');assert.equal(responses(s).filter(x=>x.willContinue===false).length,1);
 });
 await test('mismatched request never adopts an asynchronous call or invents a provider boundary',async()=>{
  const s=setup();open(s);tool(s,'voice-a','Autre demande');acknowledge(s);await s.p.execute('voice-a',request,async()=>final);s.p.receiptReply('voice-a');
  assert(!responses(s).some(x=>x.scheduling==='INTERRUPT'));assert.equal(resumed(s).length,0);
 });
 await test('a final readback cannot ask for another execution',async()=>{
  const s=setup();open(s);tool(s);acknowledge(s);await s.p.execute('voice-a',request,async()=>final);
  s.p.provider({serverContent:{turnComplete:true}});s.p.receiptReply('voice-a');
  s.p.provider({toolCall:{functionCalls:[{id:'unsafe',name:'ask_samantha',args:{request}}]}});
  assert.equal(responses(s).at(-1).response.reason,'receipt_readback');
 });
 await test('public web language guard and receipt size limit also apply to asynchronous readback',async()=>{
  const s=setup();open(s);tool(s);acknowledge(s);await s.p.execute('voice-a',request,async()=>({voice:{mode:'public_web'}}));
  assert.throws(()=>s.p.receiptReply('voice-a'),/public_web_readback_language_required/);
  const t=setup();open(t);tool(t);acknowledge(t);await t.p.execute('voice-a',request,async()=>({state:'done',text:'x'.repeat(60000)}));t.p.receiptReply('voice-a');
  const r=responses(t).at(-1).response;assert.equal(r.truncated,true);assert.equal(r.result.length,48000);
 });
 await test('old protocol keeps output_open refusal and never emits unsupported scheduling',async()=>{
  const s=setup(false);open(s);tool(s);acknowledge(s);await s.p.execute('voice-a',request,async()=>final);s.p.receiptReply('voice-a');
  assert.equal(payloads(s).at(-1).payload.receiptRefused.reason,'output_open');assert(!responses(s).some(x=>x.scheduling));
 });
 await test('real S24 evidence retains a measured 22s post-receipt gap without claiming its cause was captured',()=>{
  const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/voice-async/s24-question-v1-metadata.json'),'utf8'));
  assert.equal(capture.qualification,'controlled native PCM; separate from physical acoustic proof');
  assert(capture.metrics.receipt_first_audio*1000-capture.metrics.brain_done*1000>22000);
  assert.equal(capture.provider_generation_events_captured,false);
 });
 console.log('PASS '+passed+' voice asynchronous readback tests');
})().catch(e=>{console.error(e);process.exitCode=1;});
