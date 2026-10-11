import {runModelFastPath} from "../modelFastPath";
import {callOpenClawGateway} from "./openclawAgentClient";
import {nativeError,nativeOperation,operationBody,existingNativeOperation} from "./nativeOperation";
const idPattern=/^[A-Za-z0-9_.:-]{1,160}$/;
const sensitive=/(?:token|secret|password|credential|authorization|api[_ -]?key|otp|cvv|cvc|\bbearer\b|-----BEGIN)/i;
function safe(value:any,limit=320):string|null{
 if(typeof value!=="string")return null;
 if(sensitive.test(value)||/(?:\d[ -]?){13,19}|https?:\/\/|[\w.+-]+@[\w.-]+|[A-Za-z0-9_+/=-]{48,}|(?:\/data\/|\/home\/|\/tmp\/)/.test(value))return "Détail sensible masqué";
 return value.replace(/[\r\n\t]+/g," ").slice(0,limit);
}
function iso(value:any){return typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=8640000000000000?new Date(value).toISOString():null;}
function status(value:any){return ["ok","error","skipped"].includes(value)?value:"unknown";}
export async function allJobs(){
 const response=await callOpenClawGateway("cron.list",{includeDisabled:true});
 if(!Array.isArray(response?.jobs)||response.hasMore===true||response.jobs.length>1000||response.jobs.some((job:any)=>!job||!idPattern.test(job.id)))throw nativeError("scheduler_unavailable",503);
 return response.jobs;
}
async function jobById(id:string){
 if(!idPattern.test(id))throw nativeError("invalid_automation_id");
 const job=(await allJobs()).find((row:any)=>row.id===id);
 if(!job)throw nativeError("automation_not_found",404);
 return job;
}
/** H6: only the canonical resolved decision is an authority signal. Text fields,
 * labels, paths and provider names are never payment guards. */
export type IntentProtection = "safe" | "protected" | "unavailable";
export function resolvedIntentProtection(decision:any):IntentProtection {
 if(!decision||typeof decision!=="object"||Array.isArray(decision)||decision.version!==2||
    !["EXECUTE","CLARIFY","REASON","STOP"].includes(decision.type))return "unavailable";
 const risks=[decision.risk,...[decision.plan?.risk,decision.selected?.risk].filter(x=>x!==undefined)];
 if(risks.some(r=>!["read","write","transaction","external_send","sensitive","destructive","payment","financial","finance","high","human"].includes(r)))return "unavailable";
 if(["STOP","CLARIFY"].includes(decision.type)||risks.some(r=>!["read","write"].includes(r))||
    decision.confirmationRequired===true||decision.confirmation_required===true||
    decision.humanBoundary||decision.human_boundary||decision.plan?.confirmation_required===true)return "protected";
 return "safe";
}
export function protectedPayment(decision:any){return resolvedIntentProtection(decision)!=="safe";}

export async function resolveIntentProtection(instruction:unknown,originId:string):Promise<IntentProtection>{
 if(typeof instruction!=="string"||!instruction.trim()||instruction.length>12000)return "unavailable";
 try{
  const result=await runModelFastPath(instruction,{checkOnly:true,caller:"owner",surface:"claw_live",timeoutSeconds:1,checkBudgetMs:1000,originId});
  if(!["miss","assist","eligible","clarification","known_error"].includes(result.status||""))return "unavailable";
  return resolvedIntentProtection(result.decision);
 }catch{return "unavailable";}
}
export async function jobIntentProtection(job:any):Promise<IntentProtection>{
 const payload=job?.payload;
 if(!payload||!["agentTurn","systemEvent"].includes(payload.kind))return "unavailable";
 return resolveIntentProtection(payload.kind==="agentTurn"?payload.message:payload.text,"automation-owner-guard");
}
export async function protectedJob(job:any){return await jobIntentProtection(job)!=="safe";}
export async function automationDetail(id:string){
 const job=await jobById(id);
 const protection=await jobIntentProtection(job);
 const history=await callOpenClawGateway("cron.runs",{id,limit:10});
 if(!Array.isArray(history?.entries))throw nativeError("automation_history_unavailable",503);
 return {schemaVersion:1,id,what:safe(job.description)||safe(job.name)||"Description non communiquée",
  enabled:typeof job.enabled==="boolean"?job.enabled:null,nextRunAt:iso(job.state?.nextRunAtMs),
  // R23: native cron configRevision (cron.list, S24 11/10), echoed as If-Match by PATCH /v1/automations/{id}.
  revision:typeof job.configRevision==="string"&&/^sha256:[A-Za-z0-9_-]{43}$/.test(job.configRevision)?job.configRevision:null,
  runs:history.entries.slice(0,10).map((row:any)=>({at:iso(row.runAtMs??row.ts),status:status(row.status),note:safe(row.summary)||null})),
  actionQualification:protection==="safe"?"qualified":protection==="protected"?"protected":"unavailable",
  actions:protection!=="safe"?[]:["enable","disable","run","delete","edit"]};
}
export async function changeAutomation(id:string,action:string,body:any){
 if(!idPattern.test(id)||!["enable","disable","run","delete"].includes(action))throw nativeError("invalid_automation_action");
 const operationId=operationBody(body);
 const existing=await existingNativeOperation(operationId,JSON.stringify({action:"automation."+action,target:id}));
 if(existing)return existing;
 try{
  const job=await jobById(id);
  const protection=await jobIntentProtection(job);
  if(protection!=="safe")return {success:false,state:"blocked",receipt:null,reason:protection==="protected"?"protected_automation":"automation_guard_unavailable"};
 }catch(e:any){return {success:false,state:e?.statusCode===404?"not_found":"failed",receipt:null,error:e?.statusCode===404?"automation_not_found":"scheduler_unavailable"};}
 return nativeOperation(operationId,"automation."+action,id,async()=>{
  if(action==="run"){
   const result=await callOpenClawGateway("cron.run",{id,mode:"force"});
   if(result?.ok!==true||result.ran!==true)throw nativeError("automation_dispatch_unverified",503);
   return "accepted";
  }
  if(action==="delete"){
   const result=await callOpenClawGateway("cron.remove",{id});
   if(result?.ok!==true||result.removed!==true||(await allJobs()).some((row:any)=>row.id===id))throw nativeError("automation_delete_unverified",503);
  }else{
   await callOpenClawGateway("cron.update",{id,patch:{enabled:action==="enable"}});
   if((await jobById(id)).enabled!==(action==="enable"))throw nativeError("automation_update_unverified",503);
  }
  return "completed";
 });
}
