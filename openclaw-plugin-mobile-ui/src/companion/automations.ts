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
export function protectedJob(job:any){
 // No scheduler action may bypass the existing financial/human boundary.
 return /payment|paiement|bank|bancair|biometr|3.?d.?secure|confirmation|clic.?to.?pay|topnet|maxit|termux[-_ ]notification|wallet|flouci|\botp\b|virement|transaction/i.test(JSON.stringify(job));
}
export async function automationDetail(id:string){
 const job=await jobById(id);
 const history=await callOpenClawGateway("cron.runs",{id,limit:10});
 if(!Array.isArray(history?.entries))throw nativeError("automation_history_unavailable",503);
 return {schemaVersion:1,id,what:safe(job.description)||safe(job.name)||"Description non communiquée",
  enabled:typeof job.enabled==="boolean"?job.enabled:null,nextRunAt:iso(job.state?.nextRunAtMs),
  runs:history.entries.slice(0,10).map((row:any)=>({at:iso(row.runAtMs??row.ts),status:status(row.status),note:safe(row.summary)||null})),
  actions:protectedJob(job)?[]:["enable","disable","run","delete"]};
}
export async function changeAutomation(id:string,action:string,body:any){
 if(!idPattern.test(id)||!["enable","disable","run","delete"].includes(action))throw nativeError("invalid_automation_action");
 const operationId=operationBody(body);
 const existing=await existingNativeOperation(operationId,JSON.stringify({action:"automation."+action,target:id}));
 if(existing)return existing;
 try{
  const job=await jobById(id);
  if(protectedJob(job))return {success:false,state:"blocked",receipt:null,reason:"protected_automation"};
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
