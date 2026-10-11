import {createHash} from "crypto";
import {protectedPayment,protectedJob,allJobs} from "./automations";
import {nativeError,nativeOperation,existingNativeOperation} from "./nativeOperation";
import {callOpenClawGateway} from "./openclawAgentClient";
import {confirmations} from "./confirmations";
import {ownerUuid} from "./ownerConfirmationProtocol";
import type {OwnerIntent} from "./ownerConfirmationProtocol";

// R23 / E1: PATCH /v1/automations/{id} through the existing cron.update owner (S24 captures #131,
// fixtures/s24-2026-10-11b/e1). CAS uses the Gateway's native configRevision (cron.list/cron.get) as If-Match
// and passes it to cron.update as expectedConfigRevision: the Gateway refuses a stale definition atomically.
export type EditSchedule={kind:"every";everyMs:number}|{kind:"cron";expr:string}|{kind:"at";at:string};
export type AutomationEditPatch={name?:string;schedule?:EditSchedule;message?:string;enabled?:boolean};
const own=(o:any,k:string)=>Object.prototype.hasOwnProperty.call(o,k);
const object=(o:any)=>o!==null&&typeof o==="object"&&!Array.isArray(o);
const fail=()=>{throw nativeError("invalid_automation_edit",400);};
const idPattern=/^[A-Za-z0-9_.:-]{1,100}$/;
export const AUTOMATION_REVISION=/^sha256:[A-Za-z0-9_-]{43}$/;
function plain(value:any,max:number):string{
 if(typeof value!=="string"||!value.trim()||value.length>max||/[\p{C}\p{Zl}\p{Zp}]/u.test(value))return fail();
 // Refuse sensitive material rather than silently changing a confirmed instruction.
 if(/(?:\b(?:token|secret|password|credential|authorization|otp|api[_ -]?key)\b|\bbearer\s+|-----BEGIN|\bghp_|\bgithub_pat_|\bAKIA[A-Z0-9]{16}\b|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[\w.+-]+@[\w.-]+|\b\d{6}\b)/i.test(value))throw nativeError("automation_sensitive_input",422);
 return value;
}
function field(value:string,min:number,max:number):boolean{
 return value.split(",").every(part=>{
  const m=/^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);if(!m)return false;
  if(m[2]&&(+m[2]<1||+m[2]>max-min+1))return false;
  if(m[1]==="*")return true;
  const numbers=m[1].split("-").map(Number);return numbers.every(n=>n>=min&&n<=max)&&(numbers.length===1||numbers[0]<=numbers[1]);
 });
}
function schedule(value:any,now:number):EditSchedule{
 if(!object(value))return fail();
 const keys=Object.keys(value).sort().join(",");
 if(value.kind==="every"&&keys==="everyMs,kind"&&Number.isSafeInteger(value.everyMs)&&value.everyMs>=60000&&value.everyMs<=2592000000)return {kind:"every",everyMs:value.everyMs};
 if(value.kind==="cron"&&keys==="expr,kind"&&typeof value.expr==="string"&&value.expr.length<=160){
  const fields=value.expr.trim().split(/\s+/),bounds=[[0,59],[0,23],[1,31],[1,12],[0,7]];
  if(fields.length===5&&fields.every((f:string,i:number)=>field(f,...bounds[i] as [number,number])))return {kind:"cron",expr:fields.join(" ")};
 }
 if(value.kind==="at"&&keys==="at,kind"&&typeof value.at==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.at)){
  const ms=Date.parse(value.at);if(Number.isFinite(ms)&&ms>now&&new Date(ms).toISOString().replace(".000Z","Z")===value.at.replace(".000Z","Z"))return {kind:"at",at:new Date(ms).toISOString()};
 }
 return fail();
}
export function validateAutomationEdit(value:any,now=Date.now()):AutomationEditPatch{
 if(!object(value)||Object.keys(value).length===0||Object.keys(value).some(k=>!["name","schedule","message","enabled"].includes(k)))return fail();
 // Payment refusal precedes normalization, owner reads, and confirmation consumption.
 for(const k of ["name","message"])if(own(value,k)&&protectedPayment(value[k]))throw nativeError("automation_payment_excluded",422);
 const patch:AutomationEditPatch={};
 if(own(value,"name"))patch.name=plain(value.name,160);
 if(own(value,"schedule"))patch.schedule=schedule(value.schedule,now);
 if(own(value,"message"))patch.message=plain(value.message,4000);
 if(own(value,"enabled")){if(typeof value.enabled!=="boolean")return fail();patch.enabled=value.enabled;}
 return patch;
}
export function assertAutomationEditable(job:any){
 if(protectedJob(job))throw nativeError("automation_protected",409);
}
/** Canonical JSON: sorted keys at every level, so the payload hash never depends on client key order. */
export function canonicalJson(value:any):string{
 if(Array.isArray(value))return "["+value.map(canonicalJson).join(",")+"]";
 if(object(value))return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonicalJson(value[k])).join(",")+"}";
 return JSON.stringify(value);
}
// Pure binding calculation; the consumer must assertAutomationEditable first.
export function automationEditBinding(job:any,patch:AutomationEditPatch){
 const payloadHash=createHash("sha256").update(canonicalJson(patch)).digest("hex");
 return {requiresConfirmation:job?.payload?.kind==="agentTurn"&&(own(patch,"message")||own(patch,"schedule")),scope:"automation.edit",reference:job.id,payloadHash};
}
/** Maps the validated patch onto the captured cron.update shape (CronUpdateParamsSchema, OpenClaw 2026.9.6). */
export function gatewayPatch(job:any,patch:AutomationEditPatch):Record<string,any>{
 const out:Record<string,any>={};
 if(own(patch,"name"))out.name=patch.name;
 if(own(patch,"enabled"))out.enabled=patch.enabled;
 if(patch.schedule){
  const current=object(job?.schedule)?job.schedule:{};
  // A cron expression keeps the job's own time zone and stagger; nothing is invented.
  out.schedule=patch.schedule.kind==="cron"?{kind:"cron",expr:patch.schedule.expr,...(typeof current.tz==="string"&&current.kind==="cron"?{tz:current.tz}:{}),...(Number.isSafeInteger(current.staggerMs)&&current.kind==="cron"?{staggerMs:current.staggerMs}:{})}:{...patch.schedule};
 }
 if(own(patch,"message"))out.payload={kind:"agentTurn",message:patch.message};
 return out;
}
/** True when the re-read definition carries every requested field. */
export function definitionMatches(job:any,patch:AutomationEditPatch):boolean{
 if(!object(job))return false;
 if(own(patch,"name")&&job.name!==patch.name)return false;
 if(own(patch,"enabled")&&job.enabled!==patch.enabled)return false;
 if(own(patch,"message")&&(job.payload?.kind!=="agentTurn"||job.payload.message!==patch.message))return false;
 const s=patch.schedule;
 if(s){
  const c=job.schedule;if(!object(c)||c.kind!==s.kind)return false;
  if(s.kind==="every"&&c.everyMs!==s.everyMs)return false;
  if(s.kind==="cron"&&String(c.expr).trim().split(/\s+/).join(" ")!==s.expr)return false;
  if(s.kind==="at"&&Date.parse(c.at)!==Date.parse(s.at))return false;
 }
 return true;
}
const changed=(error:any)=>error?.details?.code==="CRON_JOB_CHANGED"||/CRON_JOB_CHANGED|no longer matches the loaded version/.test(String(error?.message||""));
type EditResult=Record<string,any>&{state:string};
const refusal=(error:string,extra:Record<string,unknown>={})=>({success:false,state:"refused",receipt:null,error,...extra});
async function jobById(id:string){
 const job=(await allJobs()).find((row:any)=>row.id===id);
 if(!job)throw nativeError("automation_not_found",404);
 return job;
}
/**
 * PATCH /v1/automations/{id}. Order: payment and input validation, owner read, protection, CAS precheck,
 * confirmation challenge, then one durable native operation (receipt, single cron.update, one re-read).
 */
export async function editAutomation(id:string,body:any,ifMatch:string|undefined,now=Date.now()):Promise<EditResult>{
 if(!idPattern.test(id))throw nativeError("invalid_automation_id");
 if(!object(body)||typeof body.operationId!=="string"||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId)||
  Object.keys(body).some(k=>!["operationId","confirmationId","name","schedule","message","enabled"].includes(k))||
  own(body,"confirmationId")&&(typeof body.confirmationId!=="string"||!ownerUuid.test(body.confirmationId)))return fail();
 const {operationId,confirmationId,...fields}=body;
 const patch=validateAutomationEdit(fields,now);
 if(typeof ifMatch!=="string"||!AUTOMATION_REVISION.test(ifMatch))throw nativeError("automation_revision_required",428);
 const existing=await existingNativeOperation(operationId,JSON.stringify({action:"automation.edit",target:id}));
 if(existing)return existing;
 let job:any;
 try{job=await jobById(id);}
 catch(e:any){if(e?.statusCode===404)throw e;throw nativeError("scheduler_unavailable",503);}
 assertAutomationEditable(job);
 if(own(patch,"message")&&job.payload?.kind!=="agentTurn")throw nativeError("automation_message_unsupported",422);
 if(job.configRevision!==ifMatch)return refusal("automation_revision_conflict",{currentRevision:AUTOMATION_REVISION.test(job.configRevision)?job.configRevision:null});
 const binding=automationEditBinding(job,patch);
 if(binding.requiresConfirmation&&!confirmationId)
  return {success:false,state:"needs_confirmation",receipt:null,error:"confirmation_required",scope:binding.scope,reference:binding.reference,payloadHash:binding.payloadHash};
 const update=gatewayPatch(job,patch);
 return nativeOperation(operationId,"automation.edit",id,async()=>{
  if(binding.requiresConfirmation){
   try{
    const record=await confirmations.status(confirmationId);
    const expected:OwnerIntent={audience:"confirmation",action:{type:binding.scope,reference:binding.reference,payloadHash:binding.payloadHash},presentation:record.intent.presentation,origin:record.intent.origin};
    // Core verifies the exact binding and the biometric proof, then claims single use durably.
    await confirmations.consume(confirmationId,expected);
   }catch(error:any){
    if([400,403,404,409].includes(error?.statusCode))return {state:"refused",artifact:{reason:"confirmation_not_usable"}};
    throw error;
   }
  }
  let response:any,updateError:any;
  try{response=await callOpenClawGateway("cron.update",{id,patch:update,expectedConfigRevision:ifMatch});}catch(error:any){updateError=error;}
  if(updateError&&changed(updateError))return {state:"refused",artifact:{reason:"automation_revision_conflict"}};
  if(!updateError&&definitionMatches(response,patch)&&AUTOMATION_REVISION.test(response.configRevision))
   return {state:"completed",artifact:{revision:response.configRevision}};
  // Uncertain outcome: exactly one owner re-read, never a second cron.update.
  const after=await jobById(id);
  if(definitionMatches(after,patch))return {state:"completed",artifact:{revision:AUTOMATION_REVISION.test(after.configRevision)?after.configRevision:null}};
  if(after.configRevision===ifMatch)return {state:"refused",artifact:{reason:"automation_update_not_applied"}};
  return {state:"refused",artifact:{reason:"automation_revision_conflict"}};
 });
}
