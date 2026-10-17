const admission=require('./lib/memo-admission-fixture.cjs');
// HS8 offline owner contracts. Audio/transcripts/SDK outcomes below are synthetic,
// never S24 qualification. Production MEMO_STT_QUALIFICATION remains refused.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hs8-pipeline-'));
process.env.OPENCLAW_STATE_DIR=dir;
const boundary=require('../dist/companion/memoSttBoundary');
assert.equal(boundary.MEMO_STT_QUALIFICATION.success,false);
const owner=require('../dist/companion/memoSttOwner');
let stt=0,checks=0,effects=0,gateway=0,resolveTranscript;
owner.transcribeMemoAttachment=async()=>{stt++;return await new Promise(r=>resolveTranscript=r);};
const agent=require('../dist/companion/openclawAgentClient');
agent.callOpenClawGateway=async()=>{gateway++;throw Error('no Gateway before handoff');};
agent.submitToOpenClawAgent=async()=>{gateway++;throw Error('financial capability must not fall through');};
require('../dist/companion/openclawGatewayClient').getGatewayStatus=async()=>{gateway++;throw Error('no Gateway for capability');};
const original='  recharge Orange 7 DT\n';
const fast=require('../dist/modelFastPath');
fast.runModelFastPath=require('./lib/legacy-fast-path-as-dialogue.cjs')(async(text,opts)=>{
 assert.equal(text,original,'verbatim transcript reaches the canonical resolver/executor');
 if(opts.checkOnly){checks++;return {status:'eligible',decision:{version:2,type:'EXECUTE',risk:'transaction',confirmationRequired:true,capability:'telecom.orange.topup_own_number'}};}
 effects++;assert.equal(opts.preparedDecision.risk,'transaction');return {status:'hit',text:'Synthetic guarded handoff'};
});
const api=require('../dist/companion/intent'),runs=require('../dist/companion/runs');
const {route}=require('../dist/companion/server');
const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}');}));
const deleteThroughRoute=session=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/sessions/'+session,method:'DELETE'},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end();});
const audio={id:'synthetic_audio',serverId:'synthetic_audio',mimeType:'audio/mp4',type:'audio',sizeBytes:2048};
const submit=(id,session='memo-test')=>api.submitIntent('',session,[audio],{clientRunId:id,authority:'owner',admission:admission.ticket(id,session)});
const until=async(test)=>{for(let i=0;i<100;i++){if(await test())return;await new Promise(r=>setTimeout(r,5));}throw Error('owner did not settle');};
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 const refused=await submit('refused');assert.equal(refused.accepted,false);assert.equal(stt,0);assert.equal(checks,0);assert.equal(gateway,0);
 // Offline seam replaces module exports only; no HTTP/config input can open the frozen product gate.
 boundary.MEMO_STT_QUALIFICATION={success:true};
 const started=performance.now();const [a,b]=await Promise.all([submit('same'),submit('same')]);
 assert.ok(performance.now()-started<15000);assert.equal(a.runId,b.runId);assert.equal([a,b].filter(x=>x.duplicate).length,1);
 assert.equal(stt,1);assert.equal((await runs.getRunStatus(a.runId)).status,'transcribing');assert.equal(gateway,0);
 const registry=()=>JSON.parse(fs.readFileSync(path.join(dir,'clawmobile-companion','runs.json')));
 const hash=registry().runs.find(r=>r.runId===a.runId).requestHash;
 resolveTranscript({success:true,state:'transcribed',text:original});
 await until(async()=> (await runs.getRunStatus(a.runId)).state==='done');
 const after=await submit('same');assert.equal(after.runId,a.runId);assert.equal(after.duplicate,true);assert.equal(stt,1);assert.equal(checks,1);assert.equal(effects,1);assert.equal(gateway,0);
 const row=registry().runs.find(r=>r.runId===a.runId);assert.equal(row.requestHash,hash);assert.equal(row.userText,original);assert.equal((row.attachments||[]).length,0);assert.equal(row.memo.phase,'dispatched');
 await assert.rejects(api.submitIntent('', 'memo-test',[{...audio,id:'other',serverId:'other'}],{clientRunId:'same',authority:'owner',admission:admission.ticket('same','memo-test')}),e=>e.message==='client_run_identity_conflict');
 const failed=await submit('stt-failed');resolveTranscript({success:false,state:'refused',error:'memo_transcript_unavailable',receipt:null});
 await until(async()=> (await runs.getRunStatus(failed.runId)).status==='transcription_pending');
 assert.equal(checks,1);assert.equal(effects,1);assert.equal(gateway,0);assert.equal((await submit('stt-failed')).duplicate,true);assert.equal(stt,2);
 const cancelled=await submit('cancelled','cancel-session');assert.equal(stt,3);
 const deleted=await deleteThroughRoute('cancel-session');assert.equal(deleted.status,200);assert.equal(deleted.body.success,true);resolveTranscript({success:true,state:'transcribed',text:original});await new Promise(r=>setTimeout(r,20));
 assert.equal(checks,1);assert.equal(effects,1);assert.equal(registry().runs.some(r=>r.runId===cancelled.runId),false);
 await assert.rejects(submit('cancelled','cancel-session'),e=>e.message==='run_deleted');
 const interrupted=await submit('interrupted','restart-session');assert.equal(stt,4);
 const child=cp.execFileSync(process.execPath,['-e',`
 process.env.OPENCLAW_STATE_DIR=${JSON.stringify(dir)};
 const boundary=require('./dist/companion/memoSttBoundary');boundary.MEMO_STT_QUALIFICATION={success:true};
 require('./dist/companion/memoSttOwner').transcribeMemoAttachment=()=>{throw Error('restart must never retry STT');};
 const admission=require('./scripts/lib/memo-admission-fixture.cjs'),runs=require('./dist/companion/runs'),api=require('./dist/companion/intent');
 (async()=>{const status=await runs.getRunStatus(${JSON.stringify(interrupted.runId)});if(status.state!=='running'||status.status!=='transcription_pending')throw Error('restart must defer retry before another provider call');
 const duplicate=await api.submitIntent('','restart-session',${JSON.stringify([audio])},{clientRunId:'interrupted',authority:'owner',admission:admission.ticket('interrupted','restart-session')});if(!duplicate.duplicate||duplicate.runId!==status.runId)throw Error('restart identity changed');console.log('restart-safe');})().catch(e=>{console.error(e);process.exitCode=1;});
 `],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
 assert.match(child,/restart-safe/);await runs.deleteSession('restart-session');resolveTranscript({success:true,state:'transcribed',text:original});await new Promise(r=>setTimeout(r,20));assert.equal(effects,1);
 assert.equal((await api.submitIntent('', 'bad',[audio,audio],{authority:'owner'})).accepted,false);
 assert.equal((await api.submitIntent('', 'bad',[audio],{})).accepted,false);
 assert.equal((await api.submitIntent('text', 'bad',[audio],{authority:'owner'})).accepted,false);
 // The ordinary model handoff also keeps the audio identity after source changes.
 const modelText='Décris le paysage';
 fast.runModelFastPath=require('./lib/legacy-fast-path-as-dialogue.cjs')(async(text,opts)=>{assert.equal(text,modelText);assert.equal(opts.checkOnly,true);checks++;return {status:'miss'};});
 require('../dist/companion/openclawGatewayClient').getGatewayStatus=async()=>{gateway++;return {reachable:true};};
 agent.submitToOpenClawAgent=async(text,runId,sessionId,opts)=>{gateway++;assert.equal(opts.authority,'owner');assert.ok(text.includes(modelText));assert.ok(!text.includes('synthetic_audio'));return {success:true,accepted:true,runId,sessionId,acceptedAt:Date.now()};};
 const model=await submit('model-handoff','model-session');assert.equal(stt,5);
 resolveTranscript({success:true,state:'transcribed',text:modelText});
 await until(async()=>gateway===2);
 const modelDuplicate=await submit('model-handoff','model-session');assert.equal(modelDuplicate.runId,model.runId);assert.equal(modelDuplicate.duplicate,true);assert.equal(stt,5);assert.equal(gateway,2);
 assert.equal(registry().runs.find(r=>r.runId===model.runId).executionSource,'gateway');
 console.log('HS8 synthetic memo owner pipeline: gate, atomic identity, one STT/dispatch, verbatim financial fast path, failure, cancellation and restart passed');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
