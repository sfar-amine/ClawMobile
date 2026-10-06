const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {ClawLiveWarmCore}=require('../dist/companion/clawLiveWarm.js');
const {validateVoicePlayback}=require('../dist/companion/voicePlaybackMetadata.js');
class Provider extends EventEmitter {
 static OPEN=1;static instances=[];
 constructor(){super();this.readyState=0;this.sent=[];Provider.instances.push(this);setTimeout(()=>{this.readyState=1;this.emit('open')},1);}
 send(raw){const v=JSON.parse(raw);this.sent.push(v);if(v.setup)setTimeout(()=>this.emit('message',Buffer.from('{"setupComplete":{}}')),1);}
 close(){this.readyState=3;this.emit('close');}
}
class Local extends EventEmitter {
 constructor(){super();this.readyState=1;this.messages=[];this.closeCode=null;}
 send(raw){this.messages.push(JSON.parse(raw));}
 close(code){if(this.readyState===3)return;this.closeCode=code;this.readyState=3;this.emit('close');}
}
(async()=>{
 const core=new ClawLiveWarmCore({tokenFactory:async()=>({token:'synthetic',setup:{model:'models/fixture'}}),WebSocketImpl:Provider,retryDelay:()=>0});
 const meta={locale:'fr',client:'samantha_android',sessionId:'owner-a',protocol:2,sessionEpoch:'epoch-a'};
 const a=new Local();await core.attach(a,meta);
 const ready=a.messages.find(v=>v.warmReady).warmReady;assert.equal(ready.protocolVersion,2);assert.equal(ready.sessionEpoch,'epoch-a');
 const second=new Local();await core.attach(second,{...meta,sessionId:'other',sessionEpoch:'epoch-b'});
 assert.equal(second.closeCode,1008);assert.equal(core.status().clients,1);
 assert(!second.messages.some(v=>v.warmEvent));
 await assert.rejects(core.prewarm({...meta,sessionId:'other'}),/voice_owner_busy/);
 const send=v=>a.emit('message',Buffer.from(JSON.stringify(v)));
 send({warmControl:{turnStart:{operationId:'start-a',sessionEpoch:'epoch-a',turnId:'voice-a',firstSample:0}}});
 send({warmInput:{audio:{sessionEpoch:'epoch-a',turnId:'voice-a',firstSample:0,samples:320,sampleRate:16000,data:Buffer.alloc(640).toString('base64')}}});
 send({warmControl:{turnEnd:{operationId:'end-a',sessionEpoch:'epoch-a',turnId:'voice-a',lastSampleExclusive:320}}});
 Provider.instances[0].emit('message',Buffer.from(JSON.stringify({serverContent:{inputTranscription:{text:'Bonjour',finished:true}}})));
 let effects=0;const run=()=>{effects++;return Promise.resolve({execution:{state:'completed'}});};
 const one=core.executeVoiceCapability({sessionEpoch:'epoch-a',connectionEpoch:ready.connectionEpoch,turnId:'voice-a'},'Bonjour',run);
 const two=core.executeVoiceCapability({sessionEpoch:'epoch-a',connectionEpoch:ready.connectionEpoch,turnId:'voice-a'},'Bonjour',run);
 assert.equal(one,two);await one;assert.equal(effects,1);
 assert.throws(()=>core.executeVoiceCapability({sessionEpoch:'epoch-b',connectionEpoch:ready.connectionEpoch,turnId:'voice-a'},'Bonjour',run),/not_owned/);
 a.close();assert.equal(core.status().clients,0);assert.equal(core.status().providerReady,false);
 assert.throws(()=>core.executeVoiceCapability({sessionEpoch:'epoch-a',connectionEpoch:ready.connectionEpoch,turnId:'voice-a'},'Bonjour',run),/not_owned/);
 const legacy=new Local();await core.attach(legacy,{locale:'fr',client:'samantha_android',sessionId:'legacy'});
 assert.equal(legacy.messages.find(v=>v.warmReady).warmReady.protocolVersion,1);
 Provider.instances.at(-1).emit('message',Buffer.from('{"serverContent":{"turnComplete":true}}'));
 assert(legacy.messages.some(v=>v.serverContent));assert(!legacy.messages.some(v=>v.warmEvent));
 legacy.close();core.shutdown();
 const completed={version:1,outputGenerationId:'out-a',generationState:'completed',state:'completed',receivedFrames:100,writtenFrames:100,playedFrames:100,sampleRate:24000,clock:'audio_track_head'};
 assert.deepEqual(validateVoicePlayback(completed),completed);
 for(const change of [{playedFrames:101},{writtenFrames:99},{receivedFrames:101},{version:2},{state:'anything'},{rawAudio:'forbidden'},{playedFrames:-1}])assert.throws(()=>validateVoicePlayback({...completed,...change}),/invalid_voice_playback/);
 assert.equal(validateVoicePlayback(undefined),undefined);
 console.log(JSON.stringify({ok:true,scope:'warm-owner-v2-and-playback-schema',secondWriterRejected:true,legacyPreserved:true,executionDeduplicated:true,noRuntimeActivated:true}));
})().catch(e=>{console.error(e);process.exitCode=1});
