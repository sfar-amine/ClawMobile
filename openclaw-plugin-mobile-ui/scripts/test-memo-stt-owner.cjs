const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');const path=require('node:path');
const {memoAudioConfig,runMemoAudioOwner,transcribeMemoAttachment}=require('../dist/companion/memoSttOwner');
const {isM4aContainer,validateAttachment,attachmentContent}=require('../dist/companion/attachmentStorage');
const {MEMO_STT_QUALIFICATION,memoSttOwnerFailure}=require('../dist/companion/memoSttBoundary');
// Offline SDK contract fixtures, deliberately synthetic; not S24 audio/auth proof.
const config={auth:{profiles:{'google:claw-gemini-free':{provider:'google',mode:'api_key'}}},tools:{media:{audio:{preferredModel:'openai/synthetic-backup',timeoutSeconds:12},models:[
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
 assert.equal(projected.tools.media.audio.maxChars,undefined);
 assert.ok(projected.tools.media.models.every(x=>x.maxChars===undefined));
 assert.throws(()=>memoAudioConfig({...config,auth:{profiles:{}}}),/memo_transcript_unavailable/);
 assert.deepEqual(projected.tools.media.models.map(x=>x.timeoutSeconds),[10,15]);
 assert.equal(projected.untouched,config.untouched);assert.equal(JSON.stringify(config),before);
 for(const invalid of [null,{}, {tools:{media:{models:[]}}}, {tools:{media:{...config.tools.media,audio:{enabled:false}}}}, {tools:{media:{models:config.tools.media.models.filter(x=>x.provider!=='google')}}}])assert.throws(()=>memoAudioConfig(invalid),/memo_transcript_unavailable/);
 let calls=0;
 const owner={loadConfig:()=>config,runMediaUnderstandingFile:async p=>{
  calls++;assert.equal(p.capability,'audio');assert.equal(p.mime,'audio/mp4');assert.equal(p.filePath,'synthetic.m4a');
  assert.deepEqual(p.cfg.tools.media.models.map(x=>x.provider),['google','openai']);
  return {text:'  Recharge Orange 7 DT.  ',provider:'openai',output:{private:'synthetic'}};
 }};
 assert.deepEqual(await runMemoAudioOwner(owner,'synthetic.m4a'),{success:true,state:'transcribed',text:'  Recharge Orange 7 DT.  '});
 assert.equal(calls,1);
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
