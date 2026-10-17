const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {memoAudioConfig,runMemoAudioOwner,transcribeMemoAttachment,MEMO_TRANSCRIPTION_PROMPT}=require('../dist/companion/memoSttOwner');
const {isM4aContainer,validateAttachment,attachmentContent}=require('../dist/companion/attachmentStorage');
const {MEMO_STT_QUALIFICATION,memoSttOwnerFailure}=require('../dist/companion/memoSttBoundary');
const profile='google:claw-gemini-free', model='gemini-3.5-flash-lite';
// Offline SDK seams are synthetic; actual captures185/174 attest provenance, not a new live call.
const fixture=path.resolve(__dirname,'../fixtures/s24-2026-10-11');
const capture=require(path.join(fixture,'hs8-v2/android-memo.json'));
const profileCapture=require(path.join(fixture,'hs8-v2/gemini-free-profile.json'));
const config={auth:{profiles:{[profile]:{provider:'google',mode:'api_key'}}},tools:{media:{audio:{timeoutSeconds:12},models:[{provider:'google',model,capabilities:['audio'],timeoutSeconds:10}]}},untouched:{opaque:true}};
const box=(kind,data=Buffer.alloc(0))=>{const b=Buffer.alloc(8+data.length);b.writeUInt32BE(b.length);b.write(kind,4);data.copy(b,8);return b;};
function container(brand,handler='soun'){
 const f=Buffer.alloc(16);f.write(brand);f.write('isom',8);f.write('mp42',12);
 const h=Buffer.alloc(24);h.write(handler,8);
 return Buffer.concat([box('ftyp',f),box('moov',box('trak',box('mdia',box('hdlr',h))))]);
}
(async()=>{
 assert.equal(capture.sttViaCore138Code.model,model);assert.equal(capture.sttViaCore138Code.openaiCalled,false);assert.equal(capture.sttViaCore138Code.memo.kind.startsWith('synthetic'),true);
 assert.equal(profileCapture.profile.id,profile);assert.equal(profileCapture.providersGoogleApiKey.equalsFreeProfileKey,false);
 const before=JSON.stringify(config),cfg=memoAudioConfig(config);
 assert.deepEqual(cfg.tools.media.models.map(x=>[x.provider,x.model,x.profile]),[['google',model,profile]]);
 assert.equal(cfg.tools.media.models[0].timeoutSeconds,10);assert.equal(cfg.tools.media.audio.preferredModel,'google/'+model);
 assert.equal(cfg.tools.media.audio.maxChars,undefined);assert.equal(cfg.tools.media.models[0].maxChars,undefined);
 assert.equal(cfg.untouched,config.untouched);assert.equal(JSON.stringify(config),before);
 // Empty media list on disk in185 is qualified with the explicit same model/profile projection.
 assert.equal(memoAudioConfig({...config,tools:{media:{models:[]}}}).tools.media.models[0].model,model);
 assert.equal(memoAudioConfig({...config,tools:undefined}).tools.media.models[0].provider,'google');
 const tight=memoAudioConfig({...config,tools:{media:{...config.tools.media,audio:{maxBytes:1024,timeoutSeconds:5}}}});
 assert.equal(tight.tools.media.models[0].maxBytes,1024);assert.equal(tight.tools.media.models[0].timeoutSeconds,5);
 for(const invalid of [null,{}, {...config,auth:{profiles:{}}}, {...config,tools:{media:{audio:{enabled:false}}}}, {...config,tools:{media:{audio:{timeoutSeconds:-1}}}}])assert.throws(()=>memoAudioConfig(invalid),/memo_transcript_unavailable/);
 let calls=0;
 const owner={loadConfig:()=>config,resolveApiKeyForProvider:async p=>{assert.equal(p.profileId,profile);assert.equal(p.lockedProfile,true);return {profileId:profile,mode:'api-key'};},runMediaUnderstandingFile:async p=>{
  calls++;assert.equal(p.capability,'audio');assert.equal(p.mime,'audio/mp4');assert.equal(p.prompt,MEMO_TRANSCRIPTION_PROMPT);assert.match(p.prompt,/derja.*arabizi/);
  assert.deepEqual(p.cfg.tools.media.models.map(x=>x.provider),['google']);return {text:'  Recharge Orange 7 DT.  ',provider:'google'};
 }};
 assert.deepEqual(await runMemoAudioOwner(owner,'synthetic.m4a'),{success:true,state:'transcribed',text:'  Recharge Orange 7 DT.  '});
 for(const auth of [async()=>{throw Error('synthetic auth failure');},async()=>({profileId:'synthetic-other',mode:'api-key'}),async()=>({profileId:profile,mode:'oauth'})])assert.deepEqual(await runMemoAudioOwner({...owner,resolveApiKeyForProvider:auth},'synthetic.m4a'),memoSttOwnerFailure());
 const entryHeader=h=>({...config,tools:{media:{...config.tools.media,models:config.tools.media.models.map(x=>({...x,headers:{[h]:undefined}}))}}});
 for(const value of [
  {...config,models:{providers:{' GOOGLE ':{headers:{'X-Goog-Api-Key':undefined}}}}},
  {...config,tools:{media:{...config.tools.media,audio:{headers:{Authorization:undefined}}}}},
  entryHeader('AUTHORIZATION'),entryHeader('X-Api-Key'),
 ])assert.deepEqual(await runMemoAudioOwner({...owner,loadConfig:()=>value},'synthetic.m4a'),memoSttOwnerFailure());
 process.env.GEMINI_API_KEY_SYNTHETIC='';try{assert.deepEqual(await runMemoAudioOwner(owner,'synthetic.m4a'),memoSttOwnerFailure());}finally{delete process.env.GEMINI_API_KEY_SYNTHETIC;}
 assert.equal(calls,1,'no OpenAI/other account fallback after auth/config failures');
 const competingProvider={baseUrl:'https://synthetic.invalid',headers:{'X-Transport-Tag':'offline'}};
 Object.defineProperty(competingProvider,'apiKey',{enumerable:true,get(){throw Error('credential value must not be read');}});
 const competing={...config,models:{providers:{' GOOGLE ':competingProvider,synthetic:{untouched:true}}}};
 const projection=memoAudioConfig(competing);assert.equal(Object.hasOwn(projection.models.providers[' GOOGLE '],'apiKey'),false);
 assert.equal(Object.hasOwn(competingProvider,'apiKey'),true);assert.equal(projection.models.providers[' GOOGLE '].baseUrl,competingProvider.baseUrl);
 assert.deepEqual(projection.models.providers[' GOOGLE '].headers,competingProvider.headers);assert.equal(projection.models.providers.synthetic,competing.models.providers.synthetic);
 const exclusive={...owner,loadConfig:()=>competing,
  resolveApiKeyForProvider:async params=>{assert.equal(params.lockedProfile,true);assert.equal(params.profileId,profile);assert.equal(Object.hasOwn(params.cfg.models.providers[' GOOGLE '],'apiKey'),false);return{profileId:profile,mode:'api-key'};},
  runMediaUnderstandingFile:async params=>{assert.equal(Object.hasOwn(params.cfg.models.providers[' GOOGLE '],'apiKey'),false);assert.equal(params.cfg.tools.media.models[0].profile,profile);return{text:'Gemini free only'};}};
 assert.equal((await runMemoAudioOwner(exclusive,'synthetic.m4a')).success,true);
 for(const auth of [async()=>{throw Error('free unavailable');},async()=>({profileId:'synthetic-other',mode:'api-key'})])assert.deepEqual(await runMemoAudioOwner({...exclusive,resolveApiKeyForProvider:auth,runMediaUnderstandingFile:()=>{throw Error('no competing account may execute');}},'synthetic.m4a'),memoSttOwnerFailure());

 assert.equal((await runMemoAudioOwner({...owner,loadConfig:()=>entryHeader('X-Transport-Tag')},'synthetic.m4a')).success,true);
 assert.deepEqual(await runMemoAudioOwner({...owner,runMediaUnderstandingFile:async()=>({text:'x'.repeat(12001)})},'synthetic.m4a'),memoSttOwnerFailure());
 assert.deepEqual(await runMemoAudioOwner({...owner,runMediaUnderstandingFile:async()=>{throw Error('synthetic private error');}},'synthetic.m4a'),memoSttOwnerFailure());
 assert.equal(MEMO_STT_QUALIFICATION.success,true);
 assert.deepEqual(await transcribeMemoAttachment('../synthetic-unowned'),memoSttOwnerFailure());
 const boundary=require('../dist/companion/memoSttBoundary'),closed=Object.freeze({success:false,state:'refused',receipt:null,error:'memo_stt_not_qualified'});
 const real=fs.readFileSync(path.join(fixture,'hs8-captures/bonjour-samantha.m4a'));assert.equal(isM4aContainer(real),true);
 assert.equal(require('node:crypto').createHash('sha256').update(real).digest('hex'),capture.sttViaCore138Code.memo.sha256);
 for(const brand of ['M4A ','mp42','isom']){assert.equal(isM4aContainer(container(brand)),true);assert.equal(isM4aContainer(container(brand,'vide')),false);}
 const headerOnly=container('mp42').subarray(0,24);assert.equal(isM4aContainer(headerOnly),false);
 assert.equal(isM4aContainer(Buffer.concat([headerOnly,box('mdat',Buffer.from('soun'))])),false);
 for(const malformed of [container('mp42').subarray(0,-1),Buffer.alloc(24),Buffer.concat([headerOnly,Buffer.from([0,0,0,4,109,111,111,118])]),Buffer.concat([headerOnly,...Array.from({length:1025},()=>box('free'))])])assert.equal(isM4aContainer(malformed),false);
 assert.doesNotThrow(()=>validateAttachment(real,'audio/mp4'));
 boundary.MEMO_STT_QUALIFICATION=closed;
 try{assert.throws(()=>validateAttachment(real,'audio/mp4'),/memo_stt_not_qualified/);assert.deepEqual(await transcribeMemoAttachment('../synthetic-unowned'),closed);}
 finally{boundary.MEMO_STT_QUALIFICATION=MEMO_STT_QUALIFICATION;}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memo-owner-')),prev=process.env.CLAWMOBILE_ATTACHMENT_DIR;
 try{process.env.CLAWMOBILE_ATTACHMENT_DIR=dir;fs.writeFileSync(path.join(dir,'synthetic.m4a'),real);
  const owned=attachmentContent('synthetic');try{assert.equal(owned.mime,'audio/mp4');assert.equal(owned.size,real.length);}finally{fs.closeSync(owned.fd);}
  boundary.MEMO_STT_QUALIFICATION=closed;try{assert.throws(()=>attachmentContent('synthetic'),/attachment_not_found/);}finally{boundary.MEMO_STT_QUALIFICATION=MEMO_STT_QUALIFICATION;}}finally{if(prev===undefined)delete process.env.CLAWMOBILE_ATTACHMENT_DIR;else process.env.CLAWMOBILE_ATTACHMENT_DIR=prev;fs.rmSync(dir,{recursive:true,force:true});}
 assert.ok(fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/ci.yml'),'utf8').includes('test-memo-stt-owner.cjs'));
 console.log('HS8: qualified Gemini-only model/profile, derja arabizi, refusal of alternate auth, bounded audio-track parser and cleaned synthetic S24 memo provenance; zero live provider calls');
})().catch(e=>{console.error(e);process.exitCode=1;});
