/** Companion is the only run-registry writer and deadline owner. Gateway hooks send closed observations here. */
import {TURN_BUDGET_MS} from './companion/turnBudget';
import {createHash} from 'crypto';
import {setTimeout as scheduleDeadline,clearTimeout as clearDeadline} from 'timers';
import {ownerWhatsAppNumbers} from './modelFastPath';
import {callOpenClawGateway} from './companion/openclawAgentClient';
import {recordNativeWhatsAppIngress,nativeTurnProgressState,reserveNativeProgressNotice,settleNativeProgressNotice,
 observeNativeTurnEnd,observeNativeTurnAdoption,observeNativeTurnDelivery,observeNativeTurnStage,activeObservedNativeWhatsAppRun} from './companion/runs';
const SESSION=/^agent:main:whatsapp:direct:(\+?[1-9][0-9]{7,14})$/;
type Deps={owners?:()=>Set<string>;send?:(params:any)=>Promise<any>;
 timer?:(fn:()=>void,ms:number)=>ReturnType<typeof scheduleDeadline>;clear?:(id:ReturnType<typeof scheduleDeadline>)=>void};
export function createNativeTurnProgressOwner(deps:Deps={}){
 const owners=deps.owners||ownerWhatsAppNumbers;
 const send=deps.send||((params:any)=>callOpenClawGateway('send',params,{timeoutMs:5000,hardTimeoutMs:5000}));
 const timer=deps.timer||((fn:()=>void,ms:number)=>scheduleDeadline<[]>(fn,ms)),clear=deps.clear||clearDeadline;
 const deadlines=new Map<string,ReturnType<typeof scheduleDeadline>>();
 const peer=(key:string)=>{const m=SESSION.exec(key);if(!m)return null;const n=m[1].startsWith('+')?m[1]:'+'+m[1];return owners().has(n)?n:null;};
 const stop=(id:string)=>{const job=deadlines.get(id);if(job){clear(job);deadlines.delete(id);}};
 async function notify(id:string){
  deadlines.delete(id);const row=await nativeTurnProgressState(id);
  if(!row||!row.accountId||row.ended||row.ingressPending||row.adoptedByRunId||row.state!=='running')return;const to=peer(row.sessionKey);if(!to||!await reserveNativeProgressNotice(id))return;
  const current=await nativeTurnProgressState(id);if(!current||!current.accountId||current.ended||current.ingressPending||current.adoptedByRunId||current.state!=='running')return;
  try{const result=await send({channel:'whatsapp',to,accountId:current.accountId,message:'Je reviens vers toi.',
   idempotencyKey:'samantha-progress-'+createHash('sha256').update(id).digest('hex')});
   await settleNativeProgressNotice(id,typeof result?.messageId==='string'?'accepted':'uncertain');
  }catch{await settleNativeProgressNotice(id,'uncertain');}
 }
 return {
  /** Closed native metadata operations on the existing loopback measurement route, never business commands. */
  async observe(id:string,body:any){
   if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.sessionKey!=='string'||!peer(body.sessionKey))throw Object.assign(Error('native_turn_owner_required'),{statusCode:403});
   const allowed:Record<string,string[]>={native_ingress:['operation','sessionKey','accountId','observedMonoMs'],
    native_stage:['operation','sessionKey','kind','durationMs','model','outcome'],native_end:['operation','sessionKey','model','success'],
    native_delivery:['operation','sessionKey','observedMonoMs'],native_adoption:['operation','sessionKey','targetRunId','observedMonoMs'],native_active:['operation','sessionKey','excludeRunId']};
   const keys=typeof body.operation==='string'&&Object.prototype.hasOwnProperty.call(allowed,body.operation)?allowed[body.operation]:undefined;if(!keys||Object.keys(body).some(k=>!keys.includes(k)))throw Object.assign(Error('invalid_turn_measurement'),{statusCode:400});
   if(body.operation==='native_active'&&body.excludeRunId!==undefined&&(typeof body.excludeRunId!=='string'||!/^[-A-Za-z0-9_.:]{1,160}$/.test(body.excludeRunId)))throw Object.assign(Error('invalid_turn_measurement'),{statusCode:400});
   if(body.operation==='native_active')return {success:true,state:'observed',active:await activeObservedNativeWhatsAppRun(body.sessionKey,{excludeRunId:body.excludeRunId})};
   const row=await nativeTurnProgressState(id);if(row&&row.sessionKey!==body.sessionKey)throw Object.assign(Error('turn_measurement_identity_conflict'),{statusCode:409});
   if(body.operation==='native_adoption'){
    await observeNativeTurnAdoption(id,body.sessionKey,body.targetRunId,body.observedMonoMs);stop(id);
   }else if(body.operation==='native_ingress'){
    const observed=await recordNativeWhatsAppIngress(id,body.sessionKey,body.accountId,body.observedMonoMs);
    if(observed&&!observed.ended&&!observed.ingressPending&&!observed.adoptedByRunId&&observed.notice==='pending'&&!deadlines.has(id)&&deadlines.size<64){
     const job=timer(()=>{void notify(id).catch(()=>{});},Math.max(0,TURN_BUDGET_MS-(Number(process.hrtime.bigint()/1000000n)-observed.startedMono)));job.unref?.();deadlines.set(id,job);
    }
   }else{
    if(body.operation==='native_stage'){
     if(!['model','tool'].includes(body.kind)||body.durationMs!==null&&(!Number.isSafeInteger(body.durationMs)||body.durationMs<0||body.durationMs>600000))throw Object.assign(Error('invalid_turn_measurement'),{statusCode:400});
     await observeNativeTurnStage(id,body.kind,body.durationMs,body.model,body.sessionKey,body.outcome);
    }else if(body.operation==='native_end'){
     if(typeof body.success!=='boolean')throw Object.assign(Error('invalid_turn_measurement'),{statusCode:400});
     const closed=await observeNativeTurnEnd(id,body.model,body.success,body.sessionKey);for(const closedId of closed)stop(closedId);
    }else if(body.operation==='native_delivery')await observeNativeTurnDelivery(id,body.sessionKey,body.observedMonoMs);
   }
   return {success:true,state:'observed'};
  },
 };
}
