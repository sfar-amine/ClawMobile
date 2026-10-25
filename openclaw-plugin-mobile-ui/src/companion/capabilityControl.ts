import {execFile} from "child_process";
import {controlPaths} from "./control";
import {nativeError} from "./nativeOperation";
import {nativeOperation,existingNativeOperation} from "./nativeOperation";
import {listRunSummaries,getRunStatus,readPaymentRequests} from "./runs";
import {callOpenClawGateway,expectedCompanionSessionKey} from "./openclawAgentClient";
import * as runsOwner from "./runs";
export async function capabilityDetail(id:string):Promise<any>{
 if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(id))throw nativeError("invalid_capability_id");
 return new Promise((resolve,reject)=>execFile("python3",["-m","reporting.control_capability","--id",id],{cwd:controlPaths().playbooks,timeout:2000,maxBuffer:65536},(error,stdout)=>{
  if(error){reject(nativeError("capability_registry_unavailable",503));return;}
  try{const value=JSON.parse(stdout);if(!value||typeof value.found!=="boolean"||(!value.found&&value.item!==null)||value.found&&(value.schemaVersion!==1||!/^([a-f0-9]{64})$/.test(value.revision||"")||value.item?.id!==id||value.item?.liveState!=="unknown"||!Array.isArray(value.item.routes)||value.item.routes.length>40||!Array.isArray(value.item.examples)||value.item.examples.length>10))throw Error();resolve(value);}catch{reject(nativeError("capability_registry_unavailable",503));}
 }));
}

export async function activeConversationGenerations(id:string) {
 if(!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)||id.length>80)throw nativeError('invalid_session_id');
 const key=expectedCompanionSessionKey(id);
 const activeObserved=(runsOwner as any).activeObservedGatewayRun as undefined|((runId:string,sessionKey:string)=>Promise<boolean>);
 if(typeof activeObserved!=='function')return {success:false,state:'unavailable',items:[]};
 const rows=(await listRunSummaries({limit:100})).filter(row=>row.sessionId===id&&row.state==='running'&&
   row.ownerAdmitted===true&&row.ownerTransport==='admin_admitted'&&row.modality!=='voice').slice(0,16);
 const items=[];
 for(const row of rows)if(await activeObserved(row.runId,key))items.push({runId:row.runId,state:'running',effects:row.replayEffect||'unknown'});
 return {success:true,state:'observed',sessionId:id,items};
}

/** Existing conversation/run ledger + official chat.abort, never a cancellation engine.
 * An acknowledged generation stop does not undo, retry or settle a business effect. */
export async function interruptConversationGeneration(id:string,body:any,assertCurrent:()=>void) {
 const deadline=Date.now()+6000;
 if(typeof assertCurrent!=='function')throw nativeError('owner_admission_required',403);
 assertCurrent();
 if(!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)||id.length>80||!body||typeof body!=='object'||Array.isArray(body)||
    Object.keys(body).length!==2||Object.keys(body).some(k=>!['operationId','runId'].includes(k))||
    typeof body.operationId!=='string'||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId)||
    typeof body.runId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(body.runId))throw nativeError('invalid_generation_interrupt');
 const previous=await existingNativeOperation(body.operationId,JSON.stringify({action:'samantha.app.conversation.interrupt',target:id+':'+body.runId}));
 if(previous)return previous;
 const key=expectedCompanionSessionKey(id);
 // L0bis #422 supplies this stricter observation on the same run ledger. A
 // partially paired deployment, restart, event gap or missing onSent refuses.
 const activeObserved=(runsOwner as any).activeObservedGatewayRun as undefined|((runId:string,sessionKey:string)=>Promise<boolean>);
 if(typeof activeObserved!=='function'||!await activeObserved(body.runId,key))throw nativeError('generation_target_not_admitted',403);
 // Local proof before any Gateway read or effect. An arbitrary runId, contact
 // conversation or legacy/non-admitted run cannot use the admin connection.
 const summaries=await listRunSummaries({limit:100});
 const run=summaries.find(row=>row.runId===body.runId&&row.sessionId===id&&row.ownerAdmitted===true&&
   row.ownerTransport==='admin_admitted'&&row.modality!=='voice');
 if(!run)throw nativeError('generation_target_not_admitted',403);
 const payments=await readPaymentRequests();
 if(payments.some(row=>['executing','effect_unknown','requires_bank_action'].includes(row.state)))
   throw nativeError('protected_owner_activity',409);
 assertCurrent();
 return nativeOperation(body.operationId,'samantha.app.conversation.interrupt',id+':'+body.runId,async()=>{
   assertCurrent();
   const remaining=Math.min(5500,deadline-Date.now());
   if(remaining<1)throw nativeError('generation_interrupt_unverified',503);
   const value=await callOpenClawGateway('chat.abort',{sessionKey:key,agentId:'main',runId:body.runId,preserveSideRuns:true},
     {timeoutMs:remaining,hardTimeoutMs:remaining});
   if(value?.ok!==true||typeof value.aborted!=='boolean'||!Array.isArray(value.runIds)||
      value.runIds.some((runId:any)=>typeof runId!=='string')||value.aborted&&!value.runIds.includes(body.runId))
     throw nativeError('generation_interrupt_unverified',503);
   let timer:ReturnType<typeof setTimeout>;
   const observed=await Promise.race([getRunStatus(body.runId).catch(()=>null),
     new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,deadline-Date.now()));})]).finally(()=>clearTimeout(timer));
   return {state:'completed' as const,artifact:{generationState:value.aborted?'abort_acknowledged':'not_running',
     targetRunId:body.runId,runState:observed?.state||'unknown',effects:'not_undone',
     effectVerification:run.replayEffect==='none'?'none':'verify_existing_receipts',
     message:value.aborted?'L’arrêt de cette génération est confirmé. Les actions déjà envoyées restent à vérifier dans leurs reçus.':
       'Cette génération ne tourne plus. Cela ne confirme pas l’annulation des actions déjà envoyées.'}};
 });
}
