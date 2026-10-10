/** R22: bounded views of the existing Gateway scheduler owner. */
import {createHash} from "crypto";
import {ControlReadPool,ControlResult} from "./control";
const fail=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
const object=(v:any)=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const idPattern=/^[A-Za-z0-9_.:-]{1,160}$/;
const number=(v:any)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
const iso=(v:any)=>number(v)&&v<=8640000000000000?new Date(v).toISOString():null;
function missingJob(value:any){
 if(value?.code==="CRON_JOB_NOT_FOUND"||value?.error?.details?.code==="CRON_JOB_NOT_FOUND"||value?.details?.code==="CRON_JOB_NOT_FOUND")return true;
 if(typeof value?.message==="string"&&value.message.length<=16384){try{return JSON.parse(value.message)?.error?.details?.code==="CRON_JOB_NOT_FOUND";}catch{}}
 return false;
}
export function automationRunsQuery(id:string,parameters:URLSearchParams){
 if(typeof id!=="string"||!idPattern.test(id))throw fail("invalid_automation_id");
 for(const [key]of parameters)if(key!=="limit"||parameters.getAll(key).length!==1)throw fail("invalid_automation_runs_query");
 const raw=parameters.get("limit")??"20";
 if(!/^(?:[1-9]|[1-4][0-9]|50)$/.test(raw))throw fail("invalid_automation_runs_query");
 return {id,limit:Number(raw)};
}
export function uniqueAutomationJobs(jobs:any[]){
 if(!Array.isArray(jobs)||jobs.length>1000)throw fail("scheduler_unavailable",503);
 const seen=new Set<string>(),out:any[]=[];
 for(const job of jobs){if(!object(job)||typeof job.id!=="string"||!idPattern.test(job.id))throw fail("scheduler_unavailable",503);if(!seen.has(job.id)){seen.add(job.id);out.push(job);}}
 return out;
}
export function projectCronStatus(raw:any){
 if(!object(raw)||typeof raw.enabled!=="boolean"||!number(raw.jobs)||!(raw.nextWakeAtMs===null||iso(raw.nextWakeAtMs)!==null))throw fail("scheduler_unavailable",503);
 return {enabled:raw.enabled,status:raw.enabled?"healthy":"paused",jobs:raw.jobs,nextWakeAt:iso(raw.nextWakeAtMs)};
}
export function projectCronRuns(raw:any,id:string,limit:number){
 automationRunsQuery(id,new URLSearchParams({limit:String(limit)}));
 if(missingJob(raw))throw fail("automation_not_found",404);
 if(!object(raw)||!Array.isArray(raw.entries)||raw.entries.length>200)throw fail("automation_history_unavailable",503);
 const items=raw.entries.map((row:any)=>{
  if(!object(row)||row.jobId!==id||row.action!=="finished")throw fail("automation_history_unavailable",503);
  const startedAt=iso(row.runAtMs),finishedAt=iso(row.ts);
  if(startedAt&&finishedAt&&Date.parse(finishedAt)<Date.parse(startedAt))throw fail("automation_history_unavailable",503);
  return {startedAt,finishedAt,durationMs:number(row.durationMs)?row.durationMs:null,
   status:["ok","error","skipped"].includes(row.status)?row.status:"unknown",
   error:typeof row.error==="string"&&row.error.length>0?"Erreur d’exécution signalée":null};
 }).sort((a:any,b:any)=>(Date.parse(b.startedAt||"")||0)-(Date.parse(a.startedAt||"")||0)).slice(0,limit);
 return {schemaVersion:1,id,items};
}
/** Prepared consumer of the existing pool; provider injection is never a runtime source claim. */
export class AutomationRunsPreparation {
 private pool:ControlReadPool;
 constructor(private source:(query:{id:string;limit:number},signal:AbortSignal)=>Promise<any>,budgetMs=12000){this.pool=new ControlReadPool(budgetMs,2,16,1024*1024,30000);}
 async read(id:string,parameters:URLSearchParams,signal?:AbortSignal){
  const query=automationRunsQuery(id,parameters),key=JSON.stringify(["r22-history",query.id]);
  const result=await this.pool.read(key,async abort=>{
   let raw:any;try{raw=await this.source({id:query.id,limit:50},abort);}catch(error:any){
    if(missingJob(error))throw fail("automation_not_found",404);
    throw fail("automation_history_unavailable",503);
   }
   const data=projectCronRuns(raw,id,50);
   return {schemaVersion:2,sections:{automationRuns:{schemaVersion:2,resourceKey:"r22-history",dataRevision:createHash("sha256").update(JSON.stringify(data)).digest("hex"),availability:"ready",freshness:"fresh",remainingFreshMs:30000,data}}} as ControlResult;
  },signal,{cache:true});
  const data=result.sections.automationRuns.data as {schemaVersion:number;id:string;items:any[]};return {...data,items:data.items.slice(0,query.limit)};
 }
 stats(){return this.pool.stats();}
 invalidate(){this.pool.invalidate();}
}

let runtimeHistory:AutomationRunsPreparation|undefined;
export async function readAutomationRuns(id:string,parameters:URLSearchParams,signal?:AbortSignal){
 if(!runtimeHistory)runtimeHistory=new AutomationRunsPreparation(async query=>{
  const {callOpenClawGateway}=await import("./openclawAgentClient");
  return callOpenClawGateway("cron.runs",query,{timeoutMs:5000,hardTimeoutMs:5200});
 },5500);
 return runtimeHistory.read(id,parameters,signal);
}
let schedulerPool:ControlReadPool|undefined;
let schedulerLatest:any=null;
let schedulerExpires=0;
let schedulerRefresh:Promise<void>|undefined;
export function schedulerHeader(raw:any,jobs:any[]){
 const scheduler=projectCronStatus(raw),unique=uniqueAutomationJobs(jobs);
 return {...scheduler,failedCount:unique.filter(job=>job.state?.lastRunStatus==="error"||Number(job.state?.consecutiveErrors)>0).length};
}
/** Header collection is asynchronous: it never delays the 300 ms automation list. */
export function completeAutomationScheduler(value:any):any{
 const data=value?.sections?.automations?.data||value?.automations||value?.data||value;
 if(!data||!Array.isArray(data.items))return value;
 if(!schedulerRefresh&&Date.now()>=schedulerExpires){
  if(!schedulerPool)schedulerPool=new ControlReadPool(5500,1,1,1024*1024,30000);
  schedulerRefresh=schedulerPool.read("r22-scheduler",async()=>{
   const {callOpenClawGateway}=await import("./openclawAgentClient");
   const {allJobs}=await import("./automations");
   const [raw,jobs]=await Promise.all([callOpenClawGateway("cron.status",{},{timeoutMs:5000,hardTimeoutMs:5200}),allJobs(5000)]);
   const data=schedulerHeader(raw,jobs);
   return {schemaVersion:2,sections:{scheduler:{schemaVersion:2,resourceKey:"r22-scheduler",dataRevision:createHash("sha256").update(JSON.stringify(data)).digest("hex"),availability:"ready",freshness:"fresh",remainingFreshMs:30000,data}}} as ControlResult;
  },undefined,{cache:true}).then(result=>{schedulerLatest=result.sections.scheduler.data;schedulerExpires=Date.now()+30000;},()=>{schedulerLatest=null;schedulerExpires=Date.now()+5000;}).finally(()=>{schedulerRefresh=undefined;});
 }
 data.items=data.items.filter((row:any,index:number,items:any[])=>typeof row?.id==="string"&&items.findIndex(other=>other?.id===row.id)===index);
 if(data.available===true){data.active=data.items.filter((row:any)=>row.enabled===true).length;data.attention=data.items.filter((row:any)=>row.enabled===true&&Number(row.consecutiveErrors)>0).length;}
 data.scheduler=Date.now()<schedulerExpires&&schedulerLatest?{...schedulerLatest}:{enabled:null,status:"unknown",jobs:null,nextWakeAt:null,failedCount:null};
 const envelope=value?.sections?.automations;
 if(envelope)envelope.dataRevision=createHash("sha256").update(JSON.stringify(data)).digest("hex");
 return value;
}

export function invalidateAutomationViews(){
 runtimeHistory?.invalidate();schedulerPool?.invalidate();schedulerLatest=null;schedulerExpires=0;
}
