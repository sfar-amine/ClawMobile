// C16 paired real IPC and canonical owners, all provider/HTTP ports MOCK_ONLY.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-pulse-paired-'));
const core=path.resolve(__dirname,'../..');
const pb=path.resolve(process.env.C16_PLAYBOOKS_ROOT||path.join(core,'../samantha-ui-playbooks'));
const expectedPeer=process.env.C16_EXPECTED_PB_SHA||'85883aa31be7dd7633a12abaebf0dbe01242d140';
assert.match(expectedPeer,/^[a-f0-9]{40}$/,'explicit immutable paired owner head');
const peerHead=spawnSync('git',['-C',pb,'rev-parse','HEAD'],{encoding:'utf8'});
assert.equal(peerHead.status,0);assert.equal(peerHead.stdout.trim(),expectedPeer,'immutable paired owner head');
const coreHead=spawnSync('git',['-C',core,'rev-parse','HEAD'],{encoding:'utf8'});
assert.equal(coreHead.status,0);
const sourceDirty=folder=>spawnSync('git',['-C',folder,'diff','--quiet','HEAD'],{encoding:'utf8'}).status!==0;
const coreDirty=sourceDirty(core),playbooksDirty=sourceDirty(pb);
process.env.HOME=root;
process.env.CLAW_UI_PLAYBOOKS_ROOT=pb;
process.env.CLAW_DIALOGUE_HOME=path.join(root,'.openclaw','dialogue');
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR=path.join(root,'.openclaw','remote-bridge');
// Canonical PB Continuum directory is discovered below via its own owner.
process.env.CLAW_CONTINUUM_FOREGROUND_DIR=path.join(root,'.openclaw','continuations','foreground');
process.env.CLAW_SERVICE_NOW='1791882000';
process.env.C16_REAL_HELPER=path.join(core,'installer/termux-lite/model-fast-path.py');
process.env.C16_FIXTURE_RESULT=path.join(root,'fixture.json');
process.env.C16_PAIRED_LOG=path.join(root,'paired.jsonl');
const fixture=spawnSync('node',['--import','./test-support/register-openclaw-stub.mjs','./test-support/native-pulse-phase-fixture.mjs','--check'],
 {cwd:path.join(pb,'billing/direct-runtime'),env:process.env,encoding:'utf8'});
assert.equal(fixture.status,0,fixture.stderr);fs.writeFileSync(process.env.C16_FIXTURE_RESULT,fixture.stdout);
const {admitNativePulseContact}=require('../dist/nativePulseAdmission');
const {runModelFastPath}=require('../dist/modelFastPath');
const {dialogueTurn,dialogueHandoff,dialogueChildRequest,dialogueRequestText}=require('../dist/dialogueSurface');
const bridge=require('../dist/companion/remoteBridge');
const e164='+21610000000',id='wa-'+crypto.createHash('sha256').update(e164).digest('hex').slice(0,16);
const sessionKey='agent:contacts-pulse:whatsapp:direct:'+e164;
let n=0,reads=0;const check=(ok,message)=>{
 if(!ok&&fs.existsSync(process.env.C16_PAIRED_LOG)){
  const diagnostics=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse)
   .filter(row=>row.kind==='MOCK_ONLY_ADMISSION_EXCEPTION'||row.kind==='MOCK_ONLY_ADMISSION_SHAPE'||row.kind==='MOCK_ONLY_VALIDATION_REJECTED');
  if(diagnostics.length)console.error(JSON.stringify({fixtureAdmissionDiagnostics:diagnostics}));
 }
 assert.ok(ok,message);n++;
};
const authority=async()=>{reads++;return {success:true,contactId:id,e164,owner:false,state:'active',rooms:['pulse'],expiresAt:null};};
const helperPath=path.join(__dirname,'fixtures/native-pulse-paired-helper.py');
const runner=(text,options)=>runModelFastPath(text,{...options,helperPath});
async function input(text,eventRef,requestContext){
 const nativePulse=await admitNativePulseContact({sessionKey,eventRef,text,isGroup:false,...(requestContext?{requestContext}:{})},authority);
 return {surface:'pulse_room',graphSurface:'whatsapp',conversationKey:nativePulse.conversationKey,
  eventRef,text,caller:'owner',nativePulse,...(requestContext?{requestContext}:{}),policy:{scope:'pulse_room',modelAllowed:false,deferHandoff:true}};
}
(async()=>{try{
 const onlyGlobalContext=process.argv.includes('--only-global-context');
 if(!onlyGlobalContext){
 const request=await input('  démarre la phase Build du projet 20495\n','native-request');
 const ready=await dialogueTurn(runner,request);
 check(ready.outcome==='READY'&&ready.reasonCode==='pulse_room_direct_write',JSON.stringify(ready));
 check(ready.pendingHandoff?.klass==='DURABLE'&&!ready.question,'complete native room request is prepared on its own event, without a confirmation question');
 const done=await dialogueHandoff(runner,request,ready.pendingHandoff.goalRef);
 check(done.outcome==='COMPLETED',JSON.stringify(done));
 const rows=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse);
 check(rows.filter(r=>r.kind==='interpretation').length===1,'exactly one interpretation for the complete native request event');
 const expectedMessageRef=input=>{
   const hash=(value,n)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,n);
   const conversation='conv-'+hash(['dialogue-conversation-v1','pulse_room',input.conversationKey.trim()],24);
   return 'evt-'+hash(['dialogue-event-v1','pulse_room',conversation,input.eventRef.trim()],32);
 };
 check(JSON.stringify(rows.filter(r=>r.kind==='interpretation').map(r=>r.message_ref))===JSON.stringify([request].map(expectedMessageRef)),
   'model-safe opaque message reference matches the exact admitted request event');
 check(rows[0].text===request.text&&rows.every(r=>r.kind!=='interpretation'||r.provenance==='server_verified'),'original text/provenance bound on real private stream');
 check(rows.filter(r=>r.kind==='MOCK_NATIVE_WRITE').length===1,'exactly one simulated native CLI write after actual grants/fences');
 const replay=await dialogueTurn(runner,request);
 check(replay.outcome==='COMPLETED'&&replay.replayed,'lost result/replay uses canonical processed event');
 check(fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').length===2,'replay invokes neither model nor effect');
 const receipts=fs.readdirSync(path.join(root,'.openclaw','remote-bridge','requests')).map(f=>JSON.parse(fs.readFileSync(path.join(root,'.openclaw','remote-bridge','requests',f))));
 check(receipts.length===1&&receipts[0].mutationRisk==='write'&&receipts[0].state==='completed','one canonical durable Bridge receipt');
 check(reads>=6,'authority was re-read at turn, prepare, dispatch and observation');
 const stat=spawnSync('python3',['-m','skill_intelligence.continuum_ingress','status','--task-id',receipts[0].taskId],{cwd:pb,env:process.env,encoding:'utf8'});
 check(stat.status===0&&JSON.parse(stat.stdout).state==='completed','existing Continuum owner completed from native business verification');
 // Actual OpenClaw hook as well as the lower-level dialogue port.
 const allowlist=require('../dist/companion/whatsappAllowlist');allowlist.allowlistRead=async()=>authority();
 const {handlePulseRoomBeforeDispatch}=require('../dist/pulseRoomFastPath');
 process.env.SAMANTHA_NATIVE_PULSE_HANDOFF='1';
 const observed=[];
 const actualRunner=async(text,options)=>{const out=await runner(text,options);observed.push(out);return out;};
 const hostCall=(content,messageId)=>handlePulseRoomBeforeDispatch({content,messageId,sessionKey,channel:'whatsapp',isGroup:false},
   {messageId,sessionKey,channelId:'whatsapp'},actualRunner);
 const hookDone=await hostCall(request.text,'hook-request');
 check(hookDone.handled&&hookDone.text.includes('vérifié'),'actual contacts-pulse hook runs a complete request directly and completes only after settled native receipt');
 const hookRows=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8');
 const hookReplay=await hostCall(request.text,'hook-request');
 check(hookReplay.handled&&observed.at(-1).replayed&&fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8')===hookRows,
   'actual hook replay of the same request invokes neither interpretation nor effect');
 process.env.C16_RESULT_MODE='pre_submit_refusal';
 const refusedAnswer=await hostCall(request.text,'refused-request');
 const refusal=observed.at(-1);
 check(refusedAnswer.handled&&refusal.outcome==='FAILED'&&refusal.reasonCode==='pulse_native_contract_changed',
   'known native pre-effect refusal closes T2 with owner cause: '+JSON.stringify(refusal));
 const beforeReplay=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8');
 const refusedReplay=await hostCall(request.text,'refused-request');
 check(refusedReplay.handled&&observed.at(-1).replayed&&observed.at(-1).reasonCode==='pulse_native_contract_changed',
   'native refusal replay keeps the same terminal cause');
 check(fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8')===beforeReplay,'native refusal replay invokes neither model nor effect');
 const refusedReceipt=fs.readdirSync(path.join(root,'.openclaw','remote-bridge','requests'))
   .map(f=>JSON.parse(fs.readFileSync(path.join(root,'.openclaw','remote-bridge','requests',f))))
   .find(r=>r.result?.execution?.reason==='pulse_native_contract_changed');
 check(refusedReceipt?.state==='completed'&&refusedReceipt.result.execution.result.write_count===0,
   'canonical terminal Bridge receipt carries native refusal and zero submission');
 const failedStat=spawnSync('python3',['-m','skill_intelligence.continuum_ingress','status','--task-id',refusedReceipt.taskId],{cwd:pb,env:process.env,encoding:'utf8'});
 check(failedStat.status===0&&JSON.parse(failedStat.stdout).state==='failed','known pre-effect refusal closes existing Continuum, no retry');
 delete process.env.C16_RESULT_MODE;
 process.env.C16_RESULT_MODE='missing_state';
 const beforeMissing=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.kind==='MOCK_NATIVE_WRITE').length;
 const missing=await hostCall('change la phase Build du projet 20495','missing-state-request');
 const missingRaw=observed.at(-1);
 check(missing.handled&&missingRaw.outcome==='NEEDS_INPUT'&&!missingRaw.pendingHandoff,
   'an incomplete room write asks for its missing value before any handoff: '+JSON.stringify(missingRaw));
 check(fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.kind==='MOCK_NATIVE_WRITE').length===beforeMissing,
   'the missing-value question causes no effect');
 const completedMissing=await hostCall('démarré','missing-state-answer');
 check(completedMissing.handled&&completedMissing.text.includes('vérifié')&&observed.at(-1).goalRef===missingRaw.goalRef,
   'the admitted answer completes the same goal directly, without an extra confirmation');
 check(fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.kind==='MOCK_NATIVE_WRITE').length===beforeMissing+1,
   'the completed request writes exactly once');
 delete process.env.C16_RESULT_MODE;
 for(const mode of ['data_closed','invalid','unsupported','ambiguous','unqualified']){
   process.env.C16_RESULT_MODE=mode;
   const before=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse);
   const answer=await hostCall(mode==='unqualified'?'affecte Fixture Collaborator au projet 20495':request.text,'hook-'+mode);
   check(answer.handled===true&&typeof answer.text==='string'&&answer.text.length>0,mode+': never yields to an outer agent');
   const raw=observed.at(-1);
   check(['TECHNICAL_FAILURE','UNRESOLVED','OUTSIDE_SCOPE','NEEDS_INPUT','NEEDS_CHOICE'].includes(raw.outcome)&&raw.modelAllowed===false,
     mode+': causal terminal/question, no model/lexical fallback');
   const after=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse);
   check(after.filter(r=>r.kind==='MOCK_NATIVE_WRITE').length===before.filter(r=>r.kind==='MOCK_NATIVE_WRITE').length,
     mode+': zero new effect');
   check(after.filter(r=>r.kind==='interpretation').length-before.filter(r=>r.kind==='interpretation').length===(mode==='data_closed'?0:1),
     mode+': DATA closed before generation, otherwise one interpretation');
   if(mode==='data_closed')check(answer.text.includes('confidentialité')&&raw.interpretationReceipt.attempts.length===0,'actual DATA closure is causal, with zero provider attempts');
   if(mode==='unqualified')check(raw.reasonCode==='native_contract_unqualified'&&answer.text.includes('pas encore qualifié'),'native unqualified cause preserved through actual room hook: '+JSON.stringify({raw,answer}));
 }
 delete process.env.C16_RESULT_MODE;
 }
 // Real Node -> private Python helper -> coordinator -> IR formatting, with the same professional purpose.
 // Native context/HTTP ports remain MOCK_ONLY here; their real C2 owner contract has its separate PB suite.
 const originalText='1. démarre la phase Build du projet 20495\n2. Explique les phases du projet';
 const requestContext={parentEventRef:'global-native-context',originalText};
 const child=dialogueChildRequest(requestContext.parentEventRef,'démarre la phase Build du projet 20495',1);
 const waiting=dialogueChildRequest(requestContext.parentEventRef,'Explique les phases du projet',2);
 const writesBefore=fs.existsSync(process.env.C16_PAIRED_LOG)?fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.kind==='MOCK_NATIVE_WRITE').length:0;
 const contextNumber='+21610000001',contextId='wa-'+crypto.createHash('sha256').update(contextNumber).digest('hex').slice(0,16);
 const contextSession='agent:contacts-pulse:whatsapp:direct:'+contextNumber;
 const contextAdmission=await admitNativePulseContact({sessionKey:contextSession,eventRef:child.eventRef,text:child.text,isGroup:false,requestContext},
   async()=>({success:true,contactId:contextId,e164:contextNumber,owner:false,state:'active',rooms:['pulse'],expiresAt:null}));
 const global={surface:'pulse_room',graphSurface:'whatsapp',conversationKey:contextAdmission.conversationKey,eventRef:child.eventRef,text:child.text,
   caller:'owner',nativePulse:contextAdmission,requestContext,queuedRequests:[waiting],policy:{scope:'pulse_room',modelAllowed:false,deferHandoff:true}};
 const globalReply=await dialogueTurn(runner,global);
 check(globalReply.outcome==='READY'&&globalReply.reasonCode==='pulse_room_direct_write'&&globalReply.pendingHandoff?.klass==='DURABLE',JSON.stringify(globalReply));
 const finalRows=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse);
 const lastIR=finalRows.filter(r=>r.kind==='interpretation').at(-1);
 check(lastIR.text===dialogueRequestText(child.text,requestContext),'exact original constraints plus active child view reaches the real paired IR');
 check(globalReply.requestQueue?.items?.some(item=>item.eventRef===waiting.eventRef&&item.parentEventRef===requestContext.parentEventRef),
   'durable sibling identity is retained in the existing coordinator projection');
 check(finalRows.filter(r=>r.kind==='MOCK_NATIVE_WRITE').length===writesBefore,'the additional context probe remains a deferred handoff with zero effect');
 const evidence={schema:'native-pulse-paired.v1',qualification:'MOCK_ONLY',core_sha:coreHead.stdout.trim(),
  playbooks_sha:peerHead.stdout.trim(),source_state:{core_dirty:coreDirty,playbooks_dirty:playbooksDirty},checks:n,passed:n,provider_calls:0,real_business_effects:0};
 if(process.env.C16_EVIDENCE_PATH)fs.writeFileSync(process.env.C16_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence));
 console.log(`Native Pulse paired: ${n}/${n} probes; MOCK_ONLY, zero provider/network/business effect`);
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
