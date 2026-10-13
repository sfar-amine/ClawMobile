import {spawn} from "child_process";
import path from "path";
import {createHash} from "crypto";
import {confirmations} from "./confirmations";
import {nativeError} from "./nativeOperation";
import {ownerUuid,type OwnerIntent} from "./ownerConfirmationProtocol";
import type {IncomingMessage} from "http";

const contactPattern=/^wa-[a-f0-9]{16}$/;
const operationPattern=/^[A-Za-z0-9_.:-]{1,128}$/;
export const allowlistReasons:ReadonlySet<string>=new Set(["owner_contact_protected","country_code_required","invalid_e164","confirmation_required","confirmation_mismatch","confirmation_expired","invalid_scope","invalid_duration","note_too_long","unknown_contact","operation_conflict","invalid_rooms","room_not_available","project_room_unavailable","pulse_room_unavailable","room_profile_unavailable","room_agent_tools_not_closed"]);
/** Access rooms (people-trusted.py ROOMS): same normalization so both sides hash the same confirmation payload. */
export const ROOMS=["conversation","projet","pulse","agenda","taches","lignes","memoire","actions","messages","maison"] as const;
const ENFORCED_ROOMS=new Set(["conversation","projet","pulse","agenda","actions","messages","maison"]);
export function normalizeRooms(value:any):string[]{
 if(!Array.isArray(value)||!value.length||value.length>ROOMS.length||value.some(r=>!(ROOMS as readonly string[]).includes(r)))fail("invalid_rooms");
 const rooms=value.includes("maison")?["maison"]:ROOMS.filter(r=>r==="conversation"||value.includes(r));
 // Same refusal as people-trusted.py ENFORCED_ROOMS, before any confirmation is asked for a room that cannot be served.
 if(rooms.some(r=>!ENFORCED_ROOMS.has(r)))fail("room_not_available",409);
 return rooms;
}
const hash=(text:string)=>createHash("sha256").update(text,"utf8").digest("hex");
const has=(value:any,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const plain=(v:any)=>!!v&&typeof v==="object"&&!Array.isArray(v);
const text=(v:any,max:number,empty=false)=>typeof v==="string"&&(empty||v.length>0)&&Array.from(v).length<=max&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(v);
function fail(reason:string,statusCode=400):never{throw nativeError(reason,statusCode);}
/** R17-only limit: drain oversized requests so its HTTP 400 can reach the caller. */
export function allowlistBody(req:IncomingMessage):Promise<any>{
 return new Promise((resolve,reject)=>{
  let size=0,invalid=false;const chunks:Buffer[]=[];
  req.on('data',chunk=>{size+=chunk.length;if(size>32768){if(!invalid){invalid=true;chunks.length=0;reject(nativeError('invalid_request',400));}return;}if(!invalid)chunks.push(Buffer.from(chunk));});
  req.on('end',()=>{if(invalid)return;try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(nativeError('invalid_request',400));}});
  req.on('error',()=>reject(nativeError('invalid_request',400)));
 });
}
function exact(body:any,allowed:string[],required:string[]){if(!plain(body)||Object.keys(body).some(k=>!allowed.includes(k))||required.some(k=>!has(body,k)))fail("invalid_request");}
function e164(value:any):string{if(typeof value!=="string"||!/^\+[1-9][0-9]{7,14}$/.test(value)){if(typeof value==="string"&&!value.startsWith("+")&&/[0-9]/.test(value))fail("country_code_required");fail("invalid_e164");}return value;}
function scope(value:any,scopeText:any){if(!["standard","claw","custom"].includes(value))fail("invalid_scope");if(value==="custom"&&!text(scopeText,500))fail("invalid_scope");if(value!=="custom"&&scopeText!==undefined&&scopeText!==null)fail("invalid_scope");return value;}
function duration(value:any){if(value!==null&&![1,3,5,7].includes(value))fail("invalid_duration");return value as null|1|3|5|7;}
function stable(value:any):any{return Array.isArray(value)?value.map(stable):plain(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;}
function digest(action:string,body:any){const copy={action,...body};delete copy.requestHash;delete copy.expectedAuthority;return hash(JSON.stringify(stable(copy)));}
function identity(e:string){return "wa-"+hash(e).slice(0,16);}
function iso(value:any){return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?value:null;}
function contact(value:any){
 if(!plain(value)||!contactPattern.test(value.contactId)||(typeof value.e164!=='string'||!/^\+[1-9][0-9]{7,14}$/.test(value.e164)||identity(value.e164)!==value.contactId)||typeof value.owner!=="boolean"||!["standard","claw","custom"].includes(value.scope)||!["active","suspended","expired_pending"].includes(value.state))fail("allowlist_unavailable",503);
 return {contactId:value.contactId,e164:value.e164,name:text(value.name,80)?value.name:null,owner:value.owner,scope:value.scope,scopeText:text(value.scopeText,500)?value.scopeText:null,state:value.state,rooms:Array.isArray(value.rooms)&&value.rooms.length&&value.rooms.every((r:any)=>(ROOMS as readonly string[]).includes(r))?value.rooms:["conversation"],expiresAt:iso(value.expiresAt),lastActivityAt:iso(value.lastActivityAt),addedAt:iso(value.addedAt),...(value.reason==='archived_history'?{reason:'archived_history'}:{})};
}
function receipt(value:any){if(value===null)return null;if(!plain(value)||value.version!==1||!operationPattern.test(value.operationId)||!contactPattern.test(value.contactId)||typeof value.action!=="string"||!['added','already_present','removed','already_absent','updated','suspended','reactivated','refused','failed','indeterminate','expired'].includes(value.state)||!iso(value.at))fail("allowlist_unavailable",503);return {version:1,operationId:value.operationId,action:value.action,contactId:value.contactId,state:value.state,at:value.at};}
function outcome(value:any){if(!plain(value)||typeof value.success!=="boolean"||!['added','already_present','removed','already_absent','updated','suspended','reactivated','refused','failed','indeterminate','not_found'].includes(value.state))fail("allowlist_unavailable",503);const state=value.statusCode===503&&!value.success?'failed':value.state;return {success:value.success,state,receipt:receipt(value.receipt??null),...(state==='failed'?{error:'allowlist_unavailable'}:{}),...(allowlistReasons.has(value.reason||value.error)?{reason:value.reason||value.error}:{})};}
function boundOutcome(value:any,body:any,action:string){const result=outcome(value);if(result.success&&!result.receipt||result.receipt&&result.receipt.state!==result.state)fail('allowlist_unavailable',503);if(result.receipt&&(result.receipt.operationId!==body.operationId||result.receipt.contactId!==body.contactId||!(({add:['added'],remove:['removed'],scope:['scope_changed'],suspend:['suspended'],reactivate:['reactivated'],expiry:['extended','shortened'],note:['note_updated'],rooms:['rooms_changed']} as Record<string,string[]>)[action]||[]).includes(result.receipt.action)))fail('allowlist_unavailable',503);return result;}
function statusFor(value:any){if(value.success||value.state==="indeterminate")return 200;const reason=value.reason;if(reason==='unknown_contact'||value.state==='not_found')return 404;if(reason==='owner_contact_protected'||reason==='operation_conflict')return 409;if(reason?.startsWith('confirmation_'))return 403;if(value.state==='failed')return 503;return 400;}

/** Existing people-trusted owner; neither argv nor diagnostics contain private request fields. */
export async function allowlistOwner(action:string,body:any={},mutation=false):Promise<any>{
 return new Promise((resolve,reject)=>{
  const helper=process.env.SAMANTHA_PEOPLE_TRUSTED||path.resolve(__dirname,"../../../installer/termux-lite/people-trusted.py");
  const child=spawn("python3",[helper,"allowlist",action],{stdio:["pipe","pipe","pipe"]});let output="",size=0,settled=false,started=false;
  function done(error?:any,value?:any){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);}
  const timer=setTimeout(()=>{child.kill();done(Object.assign(nativeError("allowlist_unavailable",503),{uncertain:mutation&&started}));},mutation?20000:10000);
  child.stderr.resume();child.on("spawn",()=>{started=true;});child.on("error",()=>done(Object.assign(nativeError("allowlist_unavailable",503),{uncertain:false})));
  child.stdout.on("data",chunk=>{size+=chunk.length;if(size>131072){child.kill();done(Object.assign(nativeError("allowlist_unavailable",503),{uncertain:mutation&&started}));}else output+=chunk;});
  child.on("close",code=>{try{if(code!==0)throw Error();const v=JSON.parse(output);if(!plain(v)||typeof v.success!=="boolean"||typeof v.state!=="string")throw Error();done(undefined,v);}catch{done(Object.assign(nativeError("allowlist_unavailable",503),{uncertain:mutation&&started}));}});
  child.stdin.on("error",()=>done(Object.assign(nativeError("allowlist_unavailable",503),{uncertain:mutation&&started})));child.stdin.end(JSON.stringify(body));
 });
}
async function getContact(contactId:string){const result=await allowlistOwner('get',{contactId});if(!result.success)fail(result.reason==='unknown_contact'||result.error==='unknown_contact'?'unknown_contact':'allowlist_unavailable',result.reason==='unknown_contact'||result.error==='unknown_contact'?404:503);return {raw:result.contact,item:contact(result.contact),historyCount:Number.isSafeInteger(result.historyCount)?result.historyCount:0};}
export async function allowlistRead(kind:'list'|'get'|'history'|'note-get',contactId?:string,parameters:any={}){
 if(contactId&&!contactPattern.test(contactId))fail('unknown_contact',404);
 if(kind==='get'){const v=await getContact(contactId!);return {success:true,state:'ok',receipt:null,...v.item,historyCount:v.historyCount};}
 const value=await allowlistOwner(kind,{...(contactId?{contactId}:{}),...parameters});if(!value.success)fail(value.reason==='unknown_contact'?'unknown_contact':'allowlist_unavailable',value.reason==='unknown_contact'?404:503);
 if(kind==='list'){if(!Array.isArray(value.items)||value.items.length>500)fail('allowlist_unavailable',503);return {success:true,state:value.state==='partial'?'partial':'ok',receipt:null,items:value.items.map(contact),issues:Array.isArray(value.issues)?value.issues.filter((x:any)=>typeof x==='string'&&/^[a-z_]{1,80}$/.test(x)):[]};}
 if(kind==='note-get'){if(typeof value.text!=='string'||Array.from(value.text).length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text))fail('allowlist_unavailable',503);return {success:true,state:value.state==='partial'?'partial':'ok',receipt:null,text:value.text,truncated:value.truncated===true,updatedAt:iso(value.updatedAt)};}
 if(!Array.isArray(value.items)||value.items.length>50)fail('allowlist_unavailable',503);
 const items=value.items.map((v:any)=>{if(!plain(v)||!contactPattern.test(v.contactId)||!iso(v.at)||!['added','removed','scope_changed','suspended','reactivated','expired','extended','shortened','note_updated','rooms_changed'].includes(v.action))fail('allowlist_unavailable',503);return {at:v.at,action:v.action,contactId:v.contactId,name:null,...(['standard','claw','custom'].includes(v.scope)?{scope:v.scope}:{}),...([1,3,5,7].includes(v.durationDays)||v.durationDays===null?{durationDays:v.durationDays}:{})};});
 return {success:true,state:value.state==='partial'?'partial':'ok',receipt:null,items,nextBefore:typeof value.nextBefore==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value.nextBefore)?value.nextBefore:null};
}
async function confirmationView(confirmationId:any,type:string,reference:string,payloadHash:string,allowConsumed:boolean){
 if(!confirmationId)fail('confirmation_required',403);if(!ownerUuid.test(confirmationId))fail('confirmation_mismatch',403);
 try{
  const record=await confirmations.status(confirmationId);
  if(record.state==='expired'||record.expiresAt<=Date.now())fail('confirmation_expired',403);
  if(record.intent.action.type!==type||record.intent.action.reference!==reference||record.intent.action.payloadHash!==payloadHash)fail('confirmation_mismatch',403);
  if(record.state!=='approved'&&!(allowConsumed&&record.state==='consumed'))fail('confirmation_mismatch',403);
  const expected:OwnerIntent={...record.intent,action:{type,reference,payloadHash}};
  return {record,expected};
 }catch(error:any){if(error.message==='confirmation_expired')throw error;if(error.statusCode&&error.statusCode!==503)fail('confirmation_mismatch',403);throw error;}
}
const flights=new Map<string,{hash:string;promise:Promise<any>}>();
export async function allowlistChange(kind:'add'|'patch'|'remove'|'note',id:string|undefined,input:any){
 const fields=kind==='add'?['operationId','confirmationId','e164','displayName','scope','scopeText','durationDays','notify']:kind==='patch'?['operationId','confirmationId','scope','scopeText','state','durationDays','rooms']:kind==='remove'?['operationId','confirmationId']:['operationId','text'];
 const required=kind==='add'?['operationId','e164','scope','durationDays','notify']:kind==='note'?['operationId','text']:['operationId'];exact(input,fields,required);
 if(!operationPattern.test(input.operationId||''))fail('invalid_operation');if(id&&!contactPattern.test(id))fail('unknown_contact',404);
 let action:string=kind,body:any={...input};
 if(kind==='add'){body.e164=e164(input.e164);id=identity(body.e164);scope(input.scope,input.scopeText);duration(input.durationDays);if(typeof input.notify!=='boolean'||input.displayName!==undefined&&!text(input.displayName,80))fail('invalid_request');}
 if(kind==='note'&&!text(input.text,2000,true))fail('note_too_long');
 if(kind==='patch'){
  const groups=[has(input,'scope')||has(input,'scopeText'),has(input,'state'),has(input,'durationDays'),has(input,'rooms')].filter(Boolean).length;if(groups!==1)fail('invalid_request');
  if(has(input,'rooms')){body.rooms=normalizeRooms(input.rooms);action='rooms';}
  else if(has(input,'state')){if(!['active','suspended'].includes(input.state))fail('invalid_request');action=input.state==='active'?'reactivate':'suspend';}
  else if(has(input,'durationDays')){duration(input.durationDays);action='expiry';}else{if(input.scope!==undefined)scope(input.scope,input.scopeText);else if(!text(input.scopeText,500))fail('invalid_scope');action='scope';}
 }
 body.contactId=id;const requestHash=digest(action,body);body.requestHash=requestHash;
 const pending=flights.get(input.operationId);if(pending){if(pending.hash!==requestHash)fail('operation_conflict',409);return pending.promise;}
 const promise=perform(action,body,kind);const owned={hash:requestHash,promise};flights.set(input.operationId,owned);try{return await promise;}finally{if(flights.get(input.operationId)===owned)flights.delete(input.operationId);}
}
async function perform(action:string,body:any,kind:string){
 let cached:any;try{cached=await allowlistOwner('operation',{operationId:body.operationId,requestHash:body.requestHash});}catch{return {status:503,value:{success:false,state:'failed',receipt:null,error:'allowlist_unavailable'}};}
 if(cached.state!=='not_found'&&cached.retryable!==true){const value=boundOutcome(cached,body,action);return {status:statusFor(value),value};}
 let current:any;try{current=(await getContact(body.contactId)).item;}catch(error:any){if(error.statusCode!==404)return {status:503,value:{success:false,state:'failed',receipt:null,error:'allowlist_unavailable'}};if(kind!=='add'&&kind!=='remove')throw error;}
 body.expectedAuthority=current?{present:current.state!=='suspended',owner:current.owner,scope:current.scope,scopeText:current.scopeText,state:current.state,expiresAt:current.expiresAt}:{present:false,owner:false,scope:null,scopeText:null,state:null,expiresAt:null};
 let confirmationType:string|undefined,payloadHash:string|undefined;
 if(kind==='add'){if(current?.owner&&body.durationDays!==null)fail('owner_contact_protected',409);if(!current||current.state==='suspended'){confirmationType='add';payloadHash=hash([body.e164,body.scope,body.scopeText||'',body.durationDays===null?'permanent':body.durationDays].join('|'));}}
 else if(kind==='remove'&&current){if(current.owner)fail('owner_contact_protected',409);confirmationType='remove';payloadHash=hash(current.e164);}
 else if(action==='suspend'){if(current.owner)fail('owner_contact_protected',409);}
 else if(action==='reactivate'){if(current.scope==='custom'&&!text(current.scopeText,500))fail('invalid_scope');confirmationType='reactivate';payloadHash=hash([current.e164,current.scope,current.scopeText||''].join('|'));}
 else if(action==='scope'){
  const target=body.scope||current.scope;scope(target,body.scopeText);if(target==='custom'&&current.scope==='custom'&&body.scopeText===undefined)fail('invalid_scope');
  const levels:any={standard:0,claw:1,custom:2};if(levels[target]>levels[current.scope]||target==='custom'&&body.scopeText!==current.scopeText){confirmationType='raise';payloadHash=hash([current.e164,target,body.scopeText||''].join('|'));}
 }
 else if(action==='rooms'){
  if(current.owner)fail('owner_contact_protected',409);
  const before:string[]=current.rooms||['conversation'];
  if(before[0]!=='maison'&&body.rooms.some((r:string)=>!before.includes(r))){confirmationType='rooms';payloadHash=hash([current.e164,...body.rooms].join('|'));}
 }
 else if(action==='expiry'){
  if(current.owner&&body.durationDays!==null)fail('owner_contact_protected',409);
  const before=current.expiresAt===null?Infinity:Date.parse(current.expiresAt),after=body.durationDays===null?Infinity:Date.now()+body.durationDays*86400000;
  if(after>before){confirmationType='extend';payloadHash=hash([current.e164,body.durationDays===null?'permanent':body.durationDays].join('|'));}
 }
 const approval=confirmationType?await confirmationView(body.confirmationId,'whatsapp.allowlist_'+confirmationType,body.contactId,payloadHash!,cached.retryable===true):undefined;
 // Existing receipt owner reserves a reversible before-effect claim, including unique
 // ownership of this confirmation, only after its byte plan and authority checks.
 let prepared:any;
 try{prepared=await allowlistOwner('prepare',{action,body},true);}catch{return {status:503,value:{success:false,state:'failed',receipt:null,error:'allowlist_unavailable'}};}
 if(!prepared.success||prepared.state!=='prepared'){
  const value=boundOutcome(prepared,body,action);return {status:statusFor(value),value};
 }
 if(approval){
  const claim=prepared.confirmationClaim;
  if(!plain(claim)||claim.operationId!==body.operationId||claim.requestHash!==body.requestHash||claim.confirmationId!==body.confirmationId||claim.type!==approval.expected.action.type||claim.reference!==body.contactId||claim.payloadHash!==payloadHash)fail('confirmation_mismatch',403);
  if(approval.record.state==='approved')await confirmations.consume(body.confirmationId,approval.expected);
  else if(prepared.allowConsumedRetry!==true||cached.retryable!==true)fail('confirmation_mismatch',403);
 }
 try{const value=boundOutcome(await allowlistOwner(action,body,true),body,action);return {status:statusFor(value),value};}
 catch(error:any){if(error.uncertain===false)return {status:503,value:{success:false,state:'failed',receipt:null,error:'allowlist_unavailable'}};
  // One receipt reread, never a second mutation or an implicit fallback dispatch.
  try{const result=await allowlistOwner('operation',{operationId:body.operationId,requestHash:body.requestHash});if(result.state!=='not_found'){const value=boundOutcome(result,body,action);return {status:statusFor(value),value};}}catch{}
  return {status:200,value:{success:false,state:'indeterminate',receipt:null}};
 }
}
