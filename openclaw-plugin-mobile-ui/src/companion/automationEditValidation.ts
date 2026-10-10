import {createHash} from "crypto";
import {protectedPayment,protectedJob} from "./automations";
import {nativeError} from "./nativeOperation";

// Preparation only: no Gateway write until R5-bis CAS and real mutation captures are qualified.
export type EditSchedule={kind:"every";everyMs:number}|{kind:"cron";expr:string}|{kind:"at";at:string};
export type AutomationEditPatch={name?:string;schedule?:EditSchedule;message?:string;enabled?:boolean};
const own=(o:any,k:string)=>Object.prototype.hasOwnProperty.call(o,k);
const object=(o:any)=>o!==null&&typeof o==="object"&&!Array.isArray(o);
const fail=()=>{throw nativeError("invalid_automation_edit",400);};
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
// Pure binding calculation; the eventual consumer must assertAutomationEditable first.
export function automationEditBinding(job:any,patch:AutomationEditPatch){
 const payloadHash=createHash("sha256").update(JSON.stringify(patch)).digest("hex");
 return {requiresConfirmation:job?.payload?.kind==="agentTurn"&&(own(patch,"message")||own(patch,"schedule")),scope:"automation.edit",reference:job.id,payloadHash};
}
