const assert=require('node:assert/strict');
const {VoiceTurnProtocol}=require('../dist/companion/voiceTurnProtocol.js');
const {VoiceTelemetry}=require('../dist/companion/voiceTelemetry.js');

let now=0;
const sent=[],events=[];
const protocol=new VoiceTurnProtocol(7,'epoch',value=>sent.push(value),()=>{},
  (event,turnId,metadata={})=>events.push({event,turnId,metadata}),()=>now,true);
const control=(kind,extra={})=>({warmControl:{[kind]:{operationId:kind,sessionEpoch:'epoch',turnId:'turn-1',...extra}}});

(async()=>{
  protocol.receive(control('turnStart',{firstSample:0}));
  protocol.receive({warmInput:{audio:{sessionEpoch:'epoch',turnId:'turn-1',firstSample:0,samples:1,sampleRate:16000,data:'AAA='}}});
  now=100;protocol.receive(control('turnEnd',{lastSampleExclusive:1}));
  now=200;protocol.receive(control('transcriptFinal',{source:'android_speech_service',text:'État de ma batterie'}));

  const match=protocol.matchingFinalRequest('État de ma batterie !');
  assert.equal(match,'turn-1');
  await protocol.measureDecision('turn-1',async()=>{now=300;return {voiceFastPath:{execute:true}}});

  now=400;protocol.provider({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm',data:'AA=='}}]}}});
  protocol.provider({serverContent:{turnComplete:true}});
  const receipt=await protocol.execute('turn-1','État de ma batterie',()=>protocol.measureCapability('turn-1',async()=>{
    now=3300;return {success:true,execution:{state:'completed'},voice:{verbatim:'Batterie : 80 %.'}};
  }));
  assert.equal(receipt.execution.state,'completed');
  protocol.receiptReply('turn-1');
  now=3700;protocol.provider({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm',data:'AA=='}}]}}});

  const audio=events.filter(row=>row.event==='t30p');
  assert.equal(audio.length,2,'waiting phrase and result audio are measured separately');
  assert.deepEqual(audio[0].metadata,{phase:0,warm_hit:true,gemini_ms:300});
  assert.deepEqual(audio[1].metadata,{phase:1,warm_hit:true,decision_ms:100,capability_ms:2900,
    gemini_ms:400,response_ms:3600,budget_ms:5000,budget_exceeded:false});
  assert.equal(sent.filter(value=>value.clientContent?.turnComplete).length,1);

  const lines=[],telemetry=new VoiceTelemetry({enabled:true,clock:()=>1n,wall:()=>1,append:(_file,line)=>lines.push(JSON.parse(line))});
  telemetry.emit('epoch',1,'t30p',audio[1].metadata);
  assert.equal(lines.length,1);assert.equal(lines[0].x.response_ms,3600);assert.equal(lines[0].x.budget_exceeded,false);
  telemetry.emit('epoch',1,'t30p',{response_stage:'secret text'});
  assert.equal(lines.length,1,'free-text latency metadata is rejected');

  console.log(JSON.stringify({passed:1,prewarmGuard:'warm_hit',budgetMs:5000,responseMs:3600,
    stages:['decision_ms','capability_ms','gemini_ms'],physicalS24:false}));
})().catch(error=>{console.error(error);process.exit(1)});
