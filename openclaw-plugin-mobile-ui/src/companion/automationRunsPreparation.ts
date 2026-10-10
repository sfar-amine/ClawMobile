/** R22 preparation only: public 2026.9.6 schema, not an installed-runtime fixture or route. */
import {createHash} from "crypto";
import {ControlReadPool,ControlResult} from "./control";
const fail=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
const object=(v:any)=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const idPattern=/^[A-Za-z0-9_.:-]{1,160}$/;
const number=(v:any)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
const iso=(v:any)=>number(v)&&v<=8640000000000000?new Date(v).toISOString():null;
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
  const query=automationRunsQuery(id,parameters),key=JSON.stringify(["r22-preparation",query.id,query.limit]);
  const result=await this.pool.read(key,async abort=>{
   let raw:any;try{raw=await this.source(query,abort);}catch{throw fail("automation_history_unavailable",503);}
   const data=projectCronRuns(raw,id,query.limit);
   return {schemaVersion:2,sections:{automationRuns:{schemaVersion:2,resourceKey:"r22-preparation",dataRevision:createHash("sha256").update(JSON.stringify(data)).digest("hex"),availability:"ready",freshness:"fresh",remainingFreshMs:30000,data}}} as ControlResult;
  },signal,{cache:true});
  return result.sections.automationRuns.data;
 }
 stats(){return this.pool.stats();}
 invalidate(){this.pool.invalidate();}
}
