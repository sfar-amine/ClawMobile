// C16 paired real IPC and canonical owners, all provider/HTTP ports MOCK_ONLY.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-pulse-paired-'));
const core=path.resolve(__dirname,'../..');
const pb=path.resolve(process.env.C16_PLAYBOOKS_ROOT||path.join(core,'../samantha-ui-playbooks'));
if(process.env.C16_EXPECTED_PB_SHA){
 const actual=spawnSync('git',['-C',pb,'rev-parse','HEAD'],{encoding:'utf8'});
 assert.equal(actual.status,0);assert.equal(actual.stdout.trim(),process.env.C16_EXPECTED_PB_SHA,'immutable paired owner head');
}
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
const {dialogueTurn,dialogueHandoff}=require('../dist/dialogueSurface');
const bridge=require('../dist/companion/remoteBridge');
const e164='+21610000000',id='wa-'+crypto.createHash('sha256').update(e164).digest('hex').slice(0,16);
const sessionKey='agent:contacts-pulse:whatsapp:direct:'+e164;
let n=0,reads=0;const check=(ok,message)=>{assert.ok(ok,message);n++;};
const authority=async()=>{reads++;return {success:true,contactId:id,e164,owner:false,state:'active',rooms:['pulse'],expiresAt:null};};
const helperPath=path.join(__dirname,'fixtures/native-pulse-paired-helper.py');
const runner=(text,options)=>runModelFastPath(text,{...options,helperPath});
async function input(text,eventRef){
 const nativePulse=await admitNativePulseContact({sessionKey,eventRef,text,isGroup:false},authority);
 return {surface:'pulse_room',graphSurface:'whatsapp',conversationKey:nativePulse.conversationKey,
  eventRef,text,caller:'owner',nativePulse,policy:{scope:'pulse_room',modelAllowed:false,deferHandoff:true}};
}
(async()=>{try{
 const request=await input('  démarre la phase Build du projet 20495\n','native-request');
 const question=await dialogueTurn(runner,request);
 check(question.outcome==='NEEDS_CONFIRMATION',JSON.stringify(question));
 check(question.question.text.includes('5309')&&question.question.text.includes('20495'),'one exact whole-command confirmation');
 const accepted=await input('  oui\n','native-accept');
 const ready=await dialogueTurn(runner,accepted);
 check(ready.outcome==='READY'&&ready.pendingHandoff,JSON.stringify(ready));
 const done=await dialogueHandoff(runner,accepted,ready.pendingHandoff.goalRef);
 check(done.outcome==='COMPLETED',JSON.stringify(done));
 const rows=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse);
 check(rows.filter(r=>r.kind==='interpretation').length===2,'exactly one interpretation per human event');
 check(rows[0].text===request.text&&rows[1].text===accepted.text&&rows.every(r=>r.kind!=='interpretation'||r.provenance==='server_verified'),'original text/provenance bound on real private stream');
 check(rows.filter(r=>r.kind==='MOCK_NATIVE_WRITE').length===1,'exactly one simulated native CLI write after actual grants/fences');
 const replay=await dialogueTurn(runner,accepted);
 check(replay.outcome==='COMPLETED'&&replay.replayed,'lost result/replay uses canonical processed event');
 check(fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').length===3,'replay invokes neither model nor effect');
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
 const hookQuestion=await hostCall(request.text,'hook-request');
 check(hookQuestion.handled&&hookQuestion.text.includes('5309'),'actual contacts-pulse hook uses the prepared whole-command question');
 const hookDone=await hostCall(accepted.text,'hook-accepted');
 check(hookDone.handled&&hookDone.text.includes('vérifié'),'actual contacts-pulse hook completes only after settled native receipt');
 for(const mode of ['data_closed','invalid','unsupported','ambiguous','unqualified']){
   process.env.C16_RESULT_MODE=mode;
   const before=fs.readFileSync(process.env.C16_PAIRED_LOG,'utf8').trim().split('\n').map(JSON.parse);
   const answer=await hostCall(request.text,'hook-'+mode);
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
 console.log(`Native Pulse paired: ${n}/${n} probes; MOCK_ONLY, zero provider/network/business effect`);
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
