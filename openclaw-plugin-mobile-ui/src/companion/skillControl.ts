import path from "path";
import {protectedPayment} from "./automations";
import {createHash} from "crypto";
import {getWorkspaceSkill,buildSkillAgentPrompt} from "./skills";
import {getWorkspaceDir} from "../tools/workspace";
import {callOpenClawGateway} from "./openclawAgentClient";
import {submitIntent} from "./intent";
import {getGatewayStatus} from "./openclawGatewayClient";
import {findSubmittedRunByClientRunId,reserveSubmittedRun,settleSubmittedRun} from "./runs";

const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});

function validate(id:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw nativeError("invalid_skill_id");}
function operation(body:any,action:string){
 if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["operationId",...(action==="try"?["instruction"]:[])].includes(k))||typeof body.operationId!=="string"||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId))throw nativeError("invalid_operation");
 if(action==="try"&&(typeof body.instruction!=="string"||!body.instruction.trim()||body.instruction.length>2000))throw nativeError("invalid_skill_instruction");
 return body.operationId as string;
}
// Explicit Gateway CLI budgets. S24 capture 10/10: skills.status = 1.8-2.4 s, 65 rows, 80 KB.
// Worst case of an activation: status 5 s + update 7 s + verification 5 s = 17 s (never the 10+5 s defaults chained).
export const SKILL_STATUS_BUDGET={timeoutMs:4000,hardTimeoutMs:5000};
export const SKILL_UPDATE_BUDGET={timeoutMs:6000,hardTimeoutMs:7000};
const STATUS_CACHE_MS=15000;
// GET /skills/{id} never waits on the Gateway beyond this: it answers partial (enabled:null) instead.
export const SKILL_DETAIL_STATUS_WAIT_MS=3000;
let statusCache:{at:number;value:Promise<any>}|null=null;
// One Gateway read per detail page burst; mutations always read fresh and invalidate the cache.
export function resetSkillStatusCache(){statusCache=null;}
function skillStatus(fresh:boolean){
 if(!fresh&&statusCache&&Date.now()-statusCache.at<STATUS_CACHE_MS)return statusCache.value;
 const value=callOpenClawGateway("skills.status",{agentId:"main"},SKILL_STATUS_BUDGET);
 statusCache={at:Date.now(),value};value.catch(()=>{if(statusCache?.value===value)statusCache=null;});
 return value;
}
async function canonicalSkill(id:string,fresh=true){
 const value=await skillStatus(fresh);
 if(!Array.isArray(value?.skills)||value.skills.length>2000)throw nativeError("skills_owner_unavailable",503);
 const expected=path.join(getWorkspaceDir(),"skills",id,"SKILL.md");
 const matches=value.skills.filter((row:any)=>typeof row.filePath==="string"&&path.resolve(row.filePath)===expected);
 if(matches.length!==1||typeof matches[0].skillKey!=="string"||!/^[A-Za-z0-9_.:-]{1,160}$/.test(matches[0].skillKey)||typeof matches[0].disabled!=="boolean")throw nativeError("skill_owner_identity_unavailable",409);
 return matches[0];
}
export async function skillControlDetail(id:string){
 validate(id);const detail=getWorkspaceSkill(id);if(!detail)throw nativeError("skill_not_found",404);
 let enabled:boolean|null=null,timer:any;try{enabled=!(await Promise.race([canonicalSkill(id,false),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(nativeError("skills_owner_slow",503)),SKILL_DETAIL_STATUS_WAIT_MS);})])).disabled;}catch{/* absence or a slow owner is not "enabled": partial, the read keeps filling the cache */}finally{clearTimeout(timer);}
 const protectedSkill=detail.risk==="high"||protectedPayment(id+" "+detail.name+" "+detail.description);
 return {...detail,success:true,state:enabled===null?"partial":"ok",receipt:null,enabled,activationAvailable:enabled!==null&&!protectedSkill,tryAvailable:enabled===true&&!protectedSkill&&!detail.requiresConfirmation};
}
function stored(status:any){
 if(status?.state!=="done"||typeof status.result!=="string")return {success:false,state:"indeterminate",receipt:null};
 try{const value=JSON.parse(status.result);if(value.receipt?.runId===status.runId&&value.receipt.version===1)return value;}catch{}
 return {success:false,state:"indeterminate",receipt:null};
}
export async function changeSkill(id:string,action:string,body:any){
 validate(id);if(!["enable","disable","try"].includes(action))throw nativeError("invalid_skill_action");
 const operationId=operation(body,action);
 const identity=JSON.stringify({action:"skill."+action,target:id,...(action==="try"?{instruction:body.instruction.trim()}: {})});
 // Same operation is bound to the complete request, independently of current skill metadata.
 const clientId="skill-operation-"+createHash("sha256").update(operationId).digest("hex"),sessionId="native-owner-actions";
 const existing=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 if(existing)return stored(existing);
 const detail=getWorkspaceSkill(id);if(!detail)throw nativeError("skill_not_found",404);
 if(detail.risk==="high"||(action==="try"&&detail.requiresConfirmation)||protectedPayment(id+" "+detail.name+" "+detail.description+" "+(body.instruction||"")))throw nativeError("protected_skill",409);
 let row:any;
 try{row=await canonicalSkill(id);}catch{return {success:false,state:"failed",receipt:null,error:"skills_owner_unavailable"};}
 if(action==="try"){
  if(row.disabled)throw nativeError("skill_disabled",409);
  if(!(await getGatewayStatus()).reachable)return {success:false,state:"failed",receipt:null,error:"skills_owner_unavailable"};
 }
 const reserved=await reserveSubmittedRun(identity,sessionId,clientId,{requestText:identity,executionSource:"capability_first",decision:{version:2,type:"EXECUTE",capability:"skill."+action}});
 if(!reserved.created)return stored(reserved.status);
 let state="indeterminate",artifact:any;
 try{
  if(action==="try"){
   const prompt=buildSkillAgentPrompt(detail,body.instruction.trim(),{});
   const result=await submitIntent(prompt,"skill-"+id,[],{userText:body.instruction.trim(),clientRunId:"skill-trial-"+createHash("sha256").update(operationId).digest("hex")});
   if(result.accepted&&result.runId){state="accepted";artifact={runId:result.runId,sessionId:result.sessionId};}
   else if(result.submissionState==="not_submitted")state="failed";
  }else{
   statusCache=null;const result=await callOpenClawGateway("skills.update",{skillKey:row.skillKey,enabled:action==="enable"},SKILL_UPDATE_BUDGET);
   if(result?.ok===true&&(await canonicalSkill(id)).disabled===(action==="disable"))state="completed";
  }
 }catch{/* An effect may have started. Never replay on an uncertain reply. */}
 const result={success:["completed","accepted"].includes(state),state,...(artifact?{artifact}:{}),...(state==="failed"?{error:"skill_trial_not_submitted"}:{}),receipt:{version:1,action:"skill."+action,target:id,operationId,runId:reserved.status.runId,state,at:reserved.status.submittedAt}};
 await settleSubmittedRun(reserved.status.runId,"done",JSON.stringify(result));
 const saved=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 return saved?stored(saved):{success:false,state:"indeterminate",receipt:null};
}
