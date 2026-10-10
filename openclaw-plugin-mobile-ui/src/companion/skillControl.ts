import path from "path";
import {createHash} from "crypto";
import {getWorkspaceSkill,buildSkillAgentPrompt} from "./skills";
import {getWorkspaceDir} from "../tools/workspace";
import {callOpenClawGateway} from "./openclawAgentClient";
import {submitIntent} from "./intent";
import {getGatewayStatus} from "./openclawGatewayClient";
import {findSubmittedRunByClientRunId,reserveSubmittedRun,settleSubmittedRun} from "./runs";

const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
const payment=/payment|paiement|bank|banque|bancair|carte|card|\botp\b|3.?d.?secure|biometr|confirmation|virement|transaction|checkout|wallet|\bd17\b|flouci|maxit|topnet|clic.?to.?pay|termux.notification/i;
function validate(id:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw nativeError("invalid_skill_id");}
function operation(body:any,action:string){
 if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["operationId",...(action==="try"?["instruction"]:[])].includes(k))||typeof body.operationId!=="string"||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId))throw nativeError("invalid_operation");
 if(action==="try"&&(typeof body.instruction!=="string"||!body.instruction.trim()||body.instruction.length>2000))throw nativeError("invalid_skill_instruction");
 return body.operationId as string;
}
async function canonicalSkill(id:string){
 const value=await callOpenClawGateway("skills.status",{agentId:"main"});
 if(!Array.isArray(value?.skills)||value.skills.length>2000)throw nativeError("skills_owner_unavailable",503);
 const expected=path.join(getWorkspaceDir(),"skills",id,"SKILL.md");
 const matches=value.skills.filter((row:any)=>typeof row.filePath==="string"&&path.resolve(row.filePath)===expected);
 if(matches.length!==1||typeof matches[0].skillKey!=="string"||!/^[A-Za-z0-9_.:-]{1,160}$/.test(matches[0].skillKey)||typeof matches[0].disabled!=="boolean")throw nativeError("skill_owner_identity_unavailable",409);
 return matches[0];
}
export async function skillControlDetail(id:string){
 validate(id);const detail=getWorkspaceSkill(id);if(!detail)throw nativeError("skill_not_found",404);
 let enabled:boolean|null=null;try{enabled=!(await canonicalSkill(id)).disabled;}catch{/* absence is not enabled */}
 const protectedSkill=detail.risk==="high"||payment.test(id+" "+detail.name+" "+detail.description);
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
 if(detail.risk==="high"||(action==="try"&&detail.requiresConfirmation)||payment.test(id+" "+detail.name+" "+detail.description+" "+(body.instruction||"")))throw nativeError("protected_skill",409);
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
   const result=await callOpenClawGateway("skills.update",{skillKey:row.skillKey,enabled:action==="enable"});
   if(result?.ok===true&&(await canonicalSkill(id)).disabled===(action==="disable"))state="completed";
  }
 }catch{/* An effect may have started. Never replay on an uncertain reply. */}
 const result={success:["completed","accepted"].includes(state),state,...(artifact?{artifact}:{}),...(state==="failed"?{error:"skill_trial_not_submitted"}:{}),receipt:{version:1,action:"skill."+action,target:id,operationId,runId:reserved.status.runId,state,at:reserved.status.submittedAt}};
 await settleSubmittedRun(reserved.status.runId,"done",JSON.stringify(result));
 const saved=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 return saved?stored(saved):{success:false,state:"indeterminate",receipt:null};
}
