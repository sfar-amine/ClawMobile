// C16 MOCK_ONLY mechanism: native admission + actual existing Bridge claim.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-pulse-'));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR=path.join(root,'bridge');
process.env.CLAW_CONTINUUM_FOREGROUND_DIR=path.join(root,'continuum');
const {admitNativePulseContact,NativePulseContact,NATIVE_PULSE_PROTOCOL}=require('../dist/nativePulseAdmission');
const bridge=require('../dist/companion/remoteBridge');
const e164='+21610000000',id='wa-'+crypto.createHash('sha256').update(e164).digest('hex').slice(0,16);
const sessionKey='agent:contacts-pulse:whatsapp:direct:'+e164;
const text='  oui\n',eventRef='host-message-accepted';
let authority={success:true,contactId:id,e164,owner:false,state:'active',rooms:['conversation','pulse'],expiresAt:null};
let reads=0,calls=0,n=0;
const check=(ok,why)=>{assert.ok(ok,why);n++;};
const read=async()=>{reads++;return {...authority};};
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function arm(taskId,requestId,params){
 const method='capability_execute_owner',stepId='continuum-step',attemptId='fixture-attempt',effectKey=taskId+'-effect';
 const fence={version:1,attemptId,effectKey,ownershipEpoch:1,ownerId:'fixture-owner',bootId:'fixture-boot'};
 const paramsHash=digest(JSON.stringify({method,params}));
 const transport_binding={version:1,requestId,taskId,stepId,method,paramsHash};
 const state={run_id:taskId,state:'running',owner:{id:fence.ownerId,boot_id:fence.bootId,lease_until:Date.now()/1000+300},
  continuum:{control:'active',ownership_epoch:1,current_attempt:attemptId,attempts:{[attemptId]:{
   state:'submitted',request_id:requestId,effect_key:effectKey,dispatch_fence:fence,transport_binding}}}};
 const dir=path.join(root,'continuum');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,taskId+'.json'),JSON.stringify(state));
 fs.writeFileSync(path.join(dir,taskId+'.events.jsonl'),JSON.stringify({taskId,after:state})+'\n');
 return {requestId,taskId,stepId,method,params,sessionId:'native-pulse:'+id,continuumFence:fence};
}
(async()=>{try{
 const admission=await admitNativePulseContact({sessionKey,eventRef,text,isGroup:false},read);
 const event={surface:'pulse_room',conversationKey:admission.conversationKey,eventRef,caller:'owner'};
 const packet=await admission.packet(event,text);
 check(packet.contact_id===id&&packet.event_ref===eventRef&&reads===2,'actual owner re-read before each private packet');
 await assert.rejects(admission.packet({...event,eventRef:'other'},text),/event_mismatch/);n++;
 await assert.rejects(admission.packet(event,text.trim()),/event_mismatch/);n++;
 for(const changes of [{state:'suspended'},{expiresAt:'2000-01-01T00:00:00Z'},{rooms:['conversation']},{owner:true},{e164:'+21610000001'}]){
  const saved=authority;authority={...authority,...changes};await assert.rejects(admission.packet(event,text),/contact_revoked/);n++;authority=saved;
 }
 for(const input of [{sessionKey:sessionKey.replace('contacts-pulse','contacts-projet-pulse'),eventRef,text,isGroup:false},
  {sessionKey,eventRef:'untracked:123',text,isGroup:false},{sessionKey,eventRef,text,isGroup:true}]){
  await assert.rejects(admitNativePulseContact(input,read),/admission_required/);n++;
 }
 assert.throws(()=>new NativePulseContact(Symbol(),id,'key',eventRef,text,sessionKey,read),/admission_required/);n++;
 const params={nativePulseProtocol:NATIVE_PULSE_PROTOCOL,conversationRef:'fixture-conversation',goalRef:'goal',acceptedEventKey:'event',commandDigest:'a'.repeat(64)};
 const body=arm('native-fixture-task','native-fixture-request',params);
 await assert.rejects(bridge.submitRemoteBridgeRequest(body),/native_pulse_admission_required/);n++;
 await assert.rejects(bridge.submitNativePulseRequest(body,JSON.parse(JSON.stringify(admission)),event,text,async()=>({})),/admission_required/);n++;
 let release,started;const seen=new Promise(resolve=>started=resolve),pending=new Promise(resolve=>release=resolve);
 const execute=async()=>{calls++;const receipt=bridge.getRemoteBridgeRequest(body.requestId);
  check(receipt.state==='running'&&receipt.mutationRisk==='write','durable write claim is persisted BEFORE callback');
  started();return pending;};
 const first=bridge.submitNativePulseRequest(body,admission,event,text,execute);await seen;
 const duplicate=await bridge.submitNativePulseRequest(body,admission,event,text,execute);
 check(duplicate.state==='running'&&calls===1,'duplicate observes existing claim and never calls native executor again');
 release({nativePulseProtocol:NATIVE_PULSE_PROTOCOL,execution:{state:'completed',result:{ok:true}}});
 const complete=await first;check(complete.state==='completed'&&calls===1,'same receipt persists callback result');
 const replay=await bridge.submitNativePulseRequest(body,admission,event,text,execute);
 check(replay.state==='completed'&&calls===1,'terminal replay only observes');
 await assert.rejects(bridge.submitNativePulseRequest({...body,params:{...params,commandDigest:'b'.repeat(64)}},admission,event,text,execute),/request_id_conflict/);n++;
 const missing=arm('missing-fence-task','missing-fence-request',params);delete missing.continuumFence;
 await assert.rejects(bridge.submitNativePulseRequest(missing,admission,event,text,execute),/admission_required/);n++;
 const stale=arm('stale-fence-task','stale-fence-request',params);stale.continuumFence.ownershipEpoch=2;
 await assert.rejects(bridge.submitNativePulseRequest(stale,admission,event,text,execute),/owner_stale/);n++;
 check(calls===1,'bad/missing fences never reached executor');
 const uncertain=arm('uncertain-native-task','uncertain-native-request',params);
 const failed=await bridge.submitNativePulseRequest(uncertain,admission,event,text,async()=>{calls++;throw Error('PRIVATE_CANARY');});
 check(failed.mutationRisk==='write'&&failed.state==='failed'&&failed.error==='native_pulse_execution_unknown'&&!JSON.stringify(failed).includes('PRIVATE_CANARY'),'callback exception masks detail and retains possible write');
 await bridge.submitNativePulseRequest(uncertain,admission,event,text,execute);
 check(calls===2,'unknown write result is never replayed');
 authority={...authority,state:'suspended'};
 await assert.rejects(bridge.submitNativePulseRequest(body,admission,event,text,execute),/contact_revoked/);n++;
 console.log(`Native Pulse host/Bridge: ${n}/${n} probes passed; MOCK_ONLY, no live effect`);
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
