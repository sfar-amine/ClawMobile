const admission=require('./lib/memo-admission-fixture.cjs');
// Offline owner continuation, not a live provider/Android qualification.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memo-retry-'));
process.env.OPENCLAW_STATE_DIR=dir;process.env.CLAWMOBILE_ATTACHMENT_DIR=path.join(dir,'audio');
const boundary=require('../dist/companion/memoSttBoundary');assert.equal(boundary.MEMO_STT_QUALIFICATION.success,false);boundary.MEMO_STT_QUALIFICATION={success:true};
const storage=require('../dist/companion/attachmentStorage'),runs=require('../dist/companion/runs'),sdk=require('../dist/companion/memoSttOwner');
const api=require('../dist/companion/intent');
let calls=0,effects=0,checks=0,resolve;
const clock=Date.now;let now=clock();Date.now=()=>now;
sdk.transcribeMemoAttachment=async()=>{calls++;return new Promise(r=>resolve=r);};
require('../dist/modelFastPath').runModelFastPath=async(text,opts)=>{assert.equal(text,'9addech batterie');if(opts.checkOnly){checks++;return {status:'eligible',decision:{version:2,type:'EXECUTE',risk:'read',confirmationRequired:false,capability:'device.assistance'}};}effects++;return {status:'hit',text:'Synthetic read receipt'};};
const source=fs.readFileSync(path.resolve(__dirname,'../fixtures/s24-2026-10-11/hs8-captures/bonjour-samantha.m4a'));
const audio=id=>storage.saveAttachments([{id,mimeType:'audio/mp4',body:source}],new Set())[0];
const rows=()=>JSON.parse(fs.readFileSync(path.join(dir,'clawmobile-companion/runs.json'))).runs;
const poll=id=>runs.getRunStatus(id);
const until=async f=>{for(let i=0;i<100;i++){if(await f())return;await new Promise(r=>setTimeout(r,5));}throw Error('memo did not settle');};
const fail=()=>resolve({success:false,state:'refused',receipt:null,error:'memo_transcript_unavailable'});
(async()=>{try{
 const attachment=audio('kept'),a=await api.submitIntent('','retry',[attachment],{clientRunId:'retry-one',authority:'owner',admission:admission.ticket('retry-one','retry')});
 const hash=rows().find(r=>r.runId===a.runId).requestHash;assert.equal(calls,1);fail();
 await until(async()=> (await poll(a.runId)).status==='transcription_pending');
 let status=await poll(a.runId);assert.equal(status.state,'running');assert.equal(status.memoTranscription.attempts,1);assert.equal(status.memoTranscription.nextAttemptAt,now+120000);assert.ok(fs.existsSync(attachment.path));
 await Promise.all(Array.from({length:12},()=>poll(a.runId)));assert.equal(calls,1,'no retry on each poll');
 now+=120000;
 await Promise.all(Array.from({length:12},(_,i)=>i%2?runs.getRunStatusByClientRunId('retry-one'):poll(a.runId)));
 assert.equal(calls,2,'twelve polls claim one provider attempt');assert.equal((await poll(a.runId)).memoTranscription.attempts,2);
 fail();await until(async()=> (await poll(a.runId)).status==='transcription_pending');
 assert.equal((await poll(a.runId)).memoTranscription.nextAttemptAt,now+600000);now+=599999;await poll(a.runId);assert.equal(calls,2);now++;
 await Promise.all(Array.from({length:12},()=>poll(a.runId)));assert.equal(calls,3);fail();
 await until(async()=> (await poll(a.runId)).state==='failed');now+=86400000;const failedStatus=await poll(a.runId);assert.equal(calls,3);assert.equal(checks,0);assert.equal(effects,0);assert.equal(fs.existsSync(attachment.path),false,'terminal transcription failure releases audio immediately');
 assert.match(failedStatus.message,/échoué.*nouveau mémo.*réessayer/i);assert.equal(failedStatus.memoTranscription.retryAllowed,true);const failedRow=rows().find(r=>r.runId===a.runId);assert.equal(failedRow.requestHash,hash);assert.equal(failedRow.attachments,undefined);assert.equal(failedRow.text,'memo:kept');assert.equal(failedRow.userText,'Mémo vocal');
 assert.equal((await api.submitIntent('','retry',[attachment],{clientRunId:'retry-one',authority:'owner',admission:admission.ticket('retry-one','retry')})).duplicate,true);
 const successAudio=audio('success'),s=await api.submitIntent('','success',[successAudio],{clientRunId:'retry-success',authority:'owner',admission:admission.ticket('retry-success','success')});
 fail();await until(async()=> (await poll(s.runId)).status==='transcription_pending');now+=120000;await poll(s.runId);assert.equal(calls,5);
 resolve({success:true,state:'transcribed',text:'9addech batterie'});await until(async()=> (await poll(s.runId)).status==='memo_ready_to_continue');
 assert.equal(checks,0);assert.equal(effects,0,'GET performs only transcription');assert.ok(fs.existsSync(successAudio.path));
 // No constant owner, forged ticket, expired ticket or revoked ticket may continue.
 const fresh=admission.ticket('retry-success','success');admission.revoke();
 for(const ticket of [undefined,{},fresh])assert.equal((await api.submitIntent('','success',[successAudio],{clientRunId:'retry-success',authority:'owner',admission:ticket})).accepted,false);
 const expired=admission.ticket('retry-success','success');now+=60001;
 assert.equal((await api.submitIntent('','success',[successAudio],{clientRunId:'retry-success',authority:'owner',admission:expired})).accepted,false);
 assert.equal(effects,0);
 const resumed=await api.submitIntent('','success',[successAudio],{clientRunId:'retry-success',authority:'owner',admission:admission.ticket('retry-success','success')});
 assert.equal(resumed.runId,s.runId);await until(async()=> (await poll(s.runId)).state==='done');
 assert.equal(effects,1);assert.equal(checks,1);assert.equal(fs.existsSync(successAudio.path),false,'successful transcript releases audio through existing owner');assert.equal(rows().find(r=>r.runId===s.runId).attachments,undefined);
 const cancelAudio=audio('cancel'),c=await api.submitIntent('','cancel',[cancelAudio],{clientRunId:'retry-cancel',authority:'owner',admission:admission.ticket('retry-cancel','cancel')});fail();await until(async()=> (await poll(c.runId)).status==='transcription_pending');
 await runs.deleteSession('cancel');now+=120000;await poll(c.runId);assert.equal(calls,6);assert.equal(effects,1,'deletion wins before retry claim');assert.equal(fs.existsSync(cancelAudio.path),false);
 // A process stop in the third STT attempt becomes terminal, not eternal pending.
 const registryFile=path.join(dir,'clawmobile-companion/runs.json'),registry=JSON.parse(fs.readFileSync(registryFile));
 const exhausted=registry.runs.find(r=>r.runId===a.runId);exhausted.state='running';exhausted.memo.phase='transcribing';exhausted.memo.attempts=3;exhausted.memo.ownerEpoch='00000000-0000-0000-0000-000000000000';delete exhausted.memo.nextAttemptAt;
 fs.writeFileSync(registryFile,JSON.stringify(registry));
 assert.equal((await poll(a.runId)).state,'failed');assert.equal(calls,6);
 // Audio expires from the upload owner's mtime-derived source expiry, even when referenced.
 now=attachment.expiresAt+1;await poll(a.runId);assert.equal(fs.existsSync(attachment.path),false);assert.equal((await poll(a.runId)).state,'failed');assert.equal(calls,6);
 // Two runs can own the same audio: cancelling one must preserve the other's reference.
 const shared=audio('shared');
 const first=await api.submitIntent('','share-a',[shared],{clientRunId:'share-a',authority:'owner',admission:admission.ticket('share-a','share-a')});
 fail();await until(async()=> (await poll(first.runId)).status==='transcription_pending');
 const second=await api.submitIntent('','share-b',[shared],{clientRunId:'share-b',authority:'owner',admission:admission.ticket('share-b','share-b')});
 fail();await until(async()=> (await poll(second.runId)).status==='transcription_pending');
 await runs.deleteSession('share-a');assert.ok(fs.existsSync(shared.path));
 await runs.deleteSession('share-b');assert.equal(fs.existsSync(shared.path),false);assert.equal(effects,1);
 // Revocation during canonical resolution blocks dispatch while preserving ready.
 const revokeAudio=audio('revoke'),r=await api.submitIntent('','revoke',[revokeAudio],{clientRunId:'revoke',authority:'owner',admission:admission.ticket('revoke','revoke')});
 const fast=require('../dist/modelFastPath'),originalFast=fast.runModelFastPath;
 fast.runModelFastPath=async(text,opts)=>{if(opts.checkOnly)admission.revoke();return originalFast(text,opts);};
 resolve({success:true,state:'transcribed',text:'9addech batterie'});
 await until(async()=> (await poll(r.runId)).status==='memo_ready_to_continue');
 assert.equal(effects,1);assert.ok(fs.existsSync(revokeAudio.path));fast.runModelFastPath=originalFast;
 await runs.deleteSession('revoke');
 now=clock();
 const retryAudio=audio('retry-fresh'),freshRetry=await api.submitIntent('','retry-fresh',[retryAudio],{clientRunId:'retry-fresh',authority:'owner',admission:admission.ticket('retry-fresh','retry-fresh')});
 assert.equal(freshRetry.accepted,true,'a new memo can retry after terminal failure');resolve({success:true,state:'transcribed',text:'9addech batterie'});await until(async()=> (await poll(freshRetry.runId)).state==='done');assert.equal(effects,2);assert.equal(fs.existsSync(retryAudio.path),false);
 console.log('HS8 deferred owner retry: two/ten-minute deadlines, bounded automatic retries, terminal audio purge, clear fresh-memo retry, stable identity, no content in failed registry, success cleanup and deletion passed');
}finally{Date.now=clock;fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
