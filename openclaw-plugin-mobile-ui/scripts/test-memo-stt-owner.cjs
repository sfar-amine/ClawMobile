const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');const path=require('node:path');
const {memoAudioConfig,runMemoAudioOwner,transcribeMemoAttachment,MEMO_TRANSCRIPTION_PROMPT}=require('../dist/companion/memoSttOwner');
const {isM4aContainer,validateAttachment,attachmentContent}=require('../dist/companion/attachmentStorage');
const {MEMO_STT_QUALIFICATION,memoSttOwnerFailure}=require('../dist/companion/memoSttBoundary');
// Offline SDK contract fixtures, deliberately synthetic; not S24 audio/auth proof.
const config={auth:{profiles:{'google:claw-gemini-free':{provider:'google',mode:'api_key'},'synthetic-existing-subscription':{provider:'openai',mode:'oauth'}}},tools:{media:{audio:{preferredModel:'openai/synthetic-backup',timeoutSeconds:12},models:[
 {provider:'openai',model:'synthetic-backup',capabilities:['audio'],timeoutSeconds:15},
 {provider:'unrelated',model:'synthetic-other',capabilities:['audio']},
 {type:'cli',command:'synthetic-cli',capabilities:['audio']},
 {provider:'google',model:'synthetic-primary',capabilities:['image','audio'],timeoutSeconds:10},
]}},untouched:{opaque:true}};
(async()=>{
 const before=JSON.stringify(config);const projected=memoAudioConfig(config);
 assert.deepEqual(projected.tools.media.models.map(x=>x.provider),['google','openai']);
 assert.deepEqual(projected.tools.media.models.map(x=>x.model),['synthetic-primary','synthetic-backup']);
 assert.equal(projected.tools.media.audio.preferredModel,'google/synthetic-primary');
 assert.equal(projected.tools.media.models[0].profile,'google:claw-gemini-free');
 assert.equal(projected.tools.media.models[1].profile,'synthetic-existing-subscription');
 const ambiguous={...config,auth:{profiles:{...config.auth.profiles,'synthetic-other-subscription':{provider:'openai',mode:'oauth'}}}};
 assert.throws(()=>memoAudioConfig(ambiguous),/memo_transcript_unavailable/);
 const selected={...ambiguous,tools:{media:{...config.tools.media,models:config.tools.media.models.map(x=>x.provider==='openai'?{...x,profile:'synthetic-existing-subscription'}:x)}}};
 assert.equal(memoAudioConfig(selected).tools.media.models[1].profile,'synthetic-existing-subscription');
 assert.throws(()=>memoAudioConfig({...config,auth:{profiles:{'google:claw-gemini-free':config.auth.profiles['google:claw-gemini-free'],'synthetic-api-key':{provider:'openai',mode:'api_key'}}}}),/memo_transcript_unavailable/);
 assert.throws(()=>memoAudioConfig({...config,tools:{media:{...config.tools.media,models:config.tools.media.models.map(x=>x.provider==='openai'?{...x,profile:'not-configured'}:x)}}}),/memo_transcript_unavailable/);
 assert.equal(projected.tools.media.audio.maxChars,undefined);
 assert.ok(projected.tools.media.models.every(x=>x.maxChars===undefined));
 assert.throws(()=>memoAudioConfig({...config,auth:{profiles:{}}}),/memo_transcript_unavailable/);
 assert.deepEqual(projected.tools.media.models.map(x=>x.timeoutSeconds),[10,12]);
 const tight=memoAudioConfig({...config,tools:{media:{...config.tools.media,audio:{maxBytes:1024,timeoutSeconds:5}}}});
 assert.ok(tight.tools.media.models.every(x=>x.maxBytes===1024&&x.timeoutSeconds===5));
 assert.equal(projected.untouched,config.untouched);assert.equal(JSON.stringify(config),before);
 for(const invalid of [null,{}, {tools:{media:{models:[]}}}, {tools:{media:{...config.tools.media,audio:{enabled:false}}}}, {tools:{media:{models:config.tools.media.models.filter(x=>x.provider!=='google')}}}])assert.throws(()=>memoAudioConfig(invalid),/memo_transcript_unavailable/);
 let calls=0;
 const owner={loadConfig:()=>config,resolveApiKeyForProvider:async p=>{assert.equal(p.provider,'google');assert.equal(p.profileId,'google:claw-gemini-free');assert.equal(p.lockedProfile,true);return {profileId:p.profileId,mode:'api-key'};},runMediaUnderstandingFile:async p=>{
  calls++;assert.equal(p.capability,'audio');assert.equal(p.mime,'audio/mp4');assert.equal(p.filePath,'synthetic.m4a');assert.equal(p.prompt,MEMO_TRANSCRIPTION_PROMPT);
  assert.deepEqual(p.cfg.tools.media.models.map(x=>x.provider),['google','openai']);
  return {text:'  Recharge Orange 7 DT.  ',provider:'openai',output:{private:'synthetic'}};
 }};
 assert.deepEqual(await runMemoAudioOwner(owner,'synthetic.m4a'),{success:true,state:'transcribed',text:'  Recharge Orange 7 DT.  '});
 assert.equal(calls,1);
 let fallbackCalls=0;
 const fallback={...owner,resolveApiKeyForProvider:async()=>{throw Error('synthetic private auth failure');},runMediaUnderstandingFile:async p=>{fallbackCalls++;assert.deepEqual(p.cfg.tools.media.models.map(x=>x.provider),['openai']);assert.equal(p.cfg.tools.media.models[0].profile,'synthetic-existing-subscription');return {text:'Bonjour'};}};
 assert.deepEqual(await runMemoAudioOwner(fallback,'synthetic.m4a'),{success:true,state:'transcribed',text:'Bonjour'});assert.equal(fallbackCalls,1);
 assert.equal((await runMemoAudioOwner({...fallback,resolveApiKeyForProvider:async()=>({profileId:'synthetic-other',mode:'api-key'})},'synthetic.m4a')).success,true);assert.equal(fallbackCalls,2);
 process.env.GEMINI_API_KEY_SYNTHETIC='';
 try{assert.equal((await runMemoAudioOwner(fallback,'synthetic.m4a')).success,true);assert.equal(fallbackCalls,3);assert.equal(calls,1);}finally{delete process.env.GEMINI_API_KEY_SYNTHETIC;}
 assert.equal((await runMemoAudioOwner({...fallback,loadConfig:()=>({...config,models:{providers:{google:{apiKey:undefined}}}})},'synthetic.m4a')).success,true);assert.equal(fallbackCalls,4);
 // Auth header names are refused before SDK execution; ordinary transport headers remain.
 const cfgWithEntryHeader=(provider,header)=>({...config,tools:{media:{...config.tools.media,models:config.tools.media.models.map(x=>x.provider===provider?{...x,headers:{[header]:undefined}}:x)}}});
 for(const configValue of [
  {...config,models:{providers:{' GOOGLE ':{apiKey:undefined}}}},
  {...config,models:{providers:{' GOOGLE ':{headers:{'X-Goog-Api-Key':undefined}}}}},
  cfgWithEntryHeader('google','AUTHORIZATION'),
 ]){assert.equal((await runMemoAudioOwner({...fallback,loadConfig:()=>configValue},'synthetic.m4a')).success,true);}
 const callsBeforeRefusals=fallbackCalls;
 for(const configValue of [
  {...config,tools:{media:{...config.tools.media,audio:{headers:{Authorization:undefined}}}}},
  {...config,models:{providers:{' OPENAI ':{headers:{authorization:undefined}}}}},
  cfgWithEntryHeader('openai','X-Api-Key'),
 ])assert.deepEqual(await runMemoAudioOwner({...fallback,loadConfig:()=>configValue},'synthetic.m4a'),memoSttOwnerFailure());
 assert.equal(fallbackCalls,callsBeforeRefusals);
 assert.equal((await runMemoAudioOwner({...owner,loadConfig:()=>cfgWithEntryHeader('google','X-Transport-Tag')},'synthetic.m4a')).success,true);
 assert.deepEqual(await runMemoAudioOwner({...owner,runMediaUnderstandingFile:async()=>({text:'x'.repeat(12001)})},'synthetic.m4a'),memoSttOwnerFailure());
 assert.deepEqual(await runMemoAudioOwner({...owner,runMediaUnderstandingFile:async()=>{throw Error('synthetic private owner error');}},'synthetic.m4a'),memoSttOwnerFailure());
 assert.deepEqual(await transcribeMemoAttachment('../synthetic-unowned'),MEMO_STT_QUALIFICATION);
 // Synthetic ftyp bytes verify only container admission shape, not codec/audio quality.
 const body=Buffer.alloc(32);body.writeUInt32BE(24);body.write('ftyp',4);body.write('M4A ',8);body.write('isom',16);body.write('mp42',20);
 assert.equal(isM4aContainer(body),true);assert.throws(()=>validateAttachment(body,'audio/mp4'),/memo_stt_not_qualified/);
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'memo-owner-'));const previous=process.env.CLAWMOBILE_ATTACHMENT_DIR;
 try{process.env.CLAWMOBILE_ATTACHMENT_DIR=tmp;fs.writeFileSync(path.join(tmp,'synthetic.m4a'),body);assert.throws(()=>attachmentContent('synthetic'),/attachment_not_found/);}finally{if(previous===undefined)delete process.env.CLAWMOBILE_ATTACHMENT_DIR;else process.env.CLAWMOBILE_ATTACHMENT_DIR=previous;fs.rmSync(tmp,{recursive:true,force:true});}
 assert.equal(isM4aContainer(Buffer.from('synthetic')),false);const malformed=Buffer.from(body);malformed.writeUInt32BE(1000);assert.equal(isM4aContainer(malformed),false);
 const workflow=fs.readFileSync(require('node:path').join(__dirname,'../../.github/workflows/ci.yml'),'utf8');assert.ok(workflow.includes('test-memo-stt-owner.cjs'));
 console.log('HS8 SDK adapter: canonical configured Google→OpenAI, bounded projection, generic failures, qualification gate and M4A container contracts passed; no provider calls');
})().catch(()=>{console.error('HS8 SDK adapter contract failed');process.exitCode=1;});
