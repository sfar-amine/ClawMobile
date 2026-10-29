// C18 MOCK_ONLY: actual Node→private Python IPC→Coordinator→Graph read_only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-fast-paired-'));
const core=path.resolve(__dirname,'../..'),pb=path.resolve(process.env.C18_PLAYBOOKS_ROOT||path.join(core,'../samantha-ui-playbooks'));
const expected=process.env.C18_EXPECTED_PB_SHA||'0d26787241cf9e71a6287d6fce6f69a18263a4a0';
assert.match(expected||'',/^[a-f0-9]{40}$/,'immutable peer SHA required');
const head=p=>{const r=spawnSync('git',['-C',p,'rev-parse','HEAD'],{encoding:'utf8'});assert.equal(r.status,0);return r.stdout.trim();};
assert.equal(head(pb),expected,'pinned peer source');
Object.assign(process.env,{HOME:home,CLAW_UI_PLAYBOOKS_ROOT:pb,CLAW_DIALOGUE_HOME:path.join(home,'.openclaw/dialogue'),
 CLAWMOBILE_REMOTE_BRIDGE_DIR:path.join(home,'.openclaw/remote-bridge'),CLAW_SERVICE_NOW:'1791882000',
 C18_REAL_HELPER:path.join(core,'installer/termux-lite/model-fast-path.py'),C18_LOG:path.join(home,'fixture.jsonl')});
const {admitNativePulseContact}=require('../dist/nativePulseAdmission');
const {runModelFastPath}=require('../dist/modelFastPath');
const {dialogueTurn,dialogueHandoff}=require('../dist/dialogueSurface');
const number='+21610000000',id='wa-'+crypto.createHash('sha256').update(number).digest('hex').slice(0,16);
const sessionKey='agent:contacts-pulse:whatsapp:direct:'+number;
let checks=0,authorityReads=0,revoked=false;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const authority=async()=>{authorityReads++;return {success:true,contactId:id,e164:number,owner:false,state:revoked?'removed':'active',rooms:revoked?[]:['pulse'],expiresAt:null};};
const runner=(text,options)=>runModelFastPath(text,{...options,helperPath:path.join(__dirname,'fixtures/native-fast-paired-helper.py')});
const rows=()=>fs.existsSync(process.env.C18_LOG)?fs.readFileSync(process.env.C18_LOG,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
async function input(ref){const text='  lis le projet 20495\n';const nativePulse=await admitNativePulseContact({sessionKey,eventRef:ref,text,isGroup:false},authority);
 return {surface:'pulse_room',graphSurface:'whatsapp',conversationKey:nativePulse.conversationKey,eventRef:ref,text,caller:'owner',nativePulse,
 policy:{scope:'pulse_room',modelAllowed:false,deferHandoff:true}};}
(async()=>{try{
 const message=await input('fast-read');const ready=await dialogueTurn(runner,message);
 check(ready.outcome==='READY'&&ready.pendingHandoff,'canonical FAST T1');
 const done=await dialogueHandoff(runner,message,ready.pendingHandoff.goalRef);
 check(done.outcome==='COMPLETED',JSON.stringify(done));
 check(rows().filter(r=>r.kind==='MOCK_INTERPRETATION').length===1,'one semantic proposal');
 check(rows()[0].text===message.text,'original text preserved');
 check(rows().filter(r=>r.kind==='MOCK_NATIVE_READ').length===1,'one read through actual Graph');
 check(rows().filter(r=>r.kind==='MOCK_SCOPE_REVALIDATION').length>=3,'scope revalidated at prepare/resume/pre-effect');
 const before=rows().length;const replay=await dialogueTurn(runner,message);
 check(replay.replayed&&replay.outcome==='COMPLETED','processed replay');check(rows().length===before,'replay no model/read');
 check(!fs.existsSync(path.join(home,'.openclaw/remote-bridge/requests')),'FAST did not claim mutation Bridge');
 check(!fs.existsSync(path.join(home,'.openclaw/continuations/foreground')),'FAST did not arm Continuum');
 const allowlist=require('../dist/companion/whatsappAllowlist');allowlist.allowlistRead=authority;
 const {handlePulseRoomBeforeDispatch}=require('../dist/pulseRoomFastPath');process.env.SAMANTHA_NATIVE_PULSE_HANDOFF='1';
 const observed=[];const hookRunner=async(text,options)=>{const out=await runner(text,options);observed.push(out);return out;};
 const hook=ref=>handlePulseRoomBeforeDispatch({content:message.text,messageId:ref,sessionKey,channel:'whatsapp',isGroup:false},
  {messageId:ref,sessionKey,channelId:'whatsapp'},hookRunner);
 const hookDone=await hook('hook-fast');check(hookDone.handled&&observed.at(-1).outcome==='COMPLETED','actual contacts-pulse hook');
 for(const mode of ['absent','revoked','boolean']){
  process.env.C18_SCOPE_MODE=mode;const count=rows().filter(r=>r.kind==='MOCK_NATIVE_READ').length;
  const answer=await hook('hook-'+mode),raw=observed.at(-1);
  check(answer.handled&&raw.modelAllowed===false&&raw.outcome==='TECHNICAL_FAILURE','closed '+mode+' cannot fall to outer agent');
  check(raw.reasonCode==='native_pulse_read_scope_unqualified','fixed causal scope refusal');
  check(rows().filter(r=>r.kind==='MOCK_NATIVE_READ').length===count,'no business read '+mode);
 }
 delete process.env.C18_SCOPE_MODE;
 const held=await input('contact-revoked');const pending=await dialogueTurn(runner,held);revoked=true;
 const {AUTHORITY_FRESH_MS}=require('../dist/nativePulseAdmission');const realNow=Date.now;Date.now=()=>realNow()+AUTHORITY_FRESH_MS;
 const count=rows().length;const refused=await dialogueHandoff(runner,held,pending.pendingHandoff.goalRef);
 Date.now=realNow;
 check(refused.outcome==='DENIED'&&refused.reasonCode==='native_pulse_admission_required','a stale read is revalidated before subprocess');
 check(rows().length===count,'revoked contact causes no helper/model/business read');
 check(authorityReads===7,'one owner read per admitted message (6) plus one refresh of the stale read, not one per private phase');
 const evidence={schema:'native-fast-paired.v1',qualification:'MOCK_ONLY',core_sha:head(core),playbooks_sha:head(pb),checks,passed:checks,provider_calls:0,real_business_effects:0};
 if(process.env.C18_EVIDENCE_PATH)fs.writeFileSync(process.env.C18_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence));
}finally{fs.rmSync(home,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
