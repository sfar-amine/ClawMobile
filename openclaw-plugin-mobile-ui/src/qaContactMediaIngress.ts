import fs from "fs/promises";
import {constants} from "fs";
import path from "path";
import {createHash} from "crypto";
import {performance} from "perf_hooks";
import {contactRoomSession} from "./contactRoomProfile";

const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const MAX_BYTES=20*1024*1024, MAX_FILES=4;
const mimes:Record<string,string>={"image/png":"png","image/jpeg":"jpg",
 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"xlsx","text/plain":"txt"};
const id=(v:any,max=300)=>typeof v==="string"&&v.length>0&&v.length<=max&&!/[\s\x00-\x1f\x7f]/.test(v);
const plain=(v:any)=>v!==null&&typeof v==="object"&&!Array.isArray(v);
export type QaMediaIdentity=Readonly<{session_key:string;message_id:string;channel_id:"whatsapp";
 account_id:string;from:string;sender_id:string;sender_e164:string;requester_hash:string;
 thread_ref:string;transport_event_id:string}>;
export type QaMediaAdmission={context:Record<string,any>;run_id:string;selected_app_id:string;
 state:"DRAFT";plan_version:number;dossier_version?:string};
type Controls={signal:AbortSignal;remaining_ms:number};
export type QaMediaOwners={
 /** Read-only canonical People + existing DRAFT binding; never creates/selects a campaign. */
 admit:(identity:QaMediaIdentity,controls:Controls)=>Promise<QaMediaAdmission|null>;
 /** From the installed SDK owner, not an environment/request path. */
 inboundRoot:(admission:QaMediaAdmission,controls:Controls)=>Promise<string>;
 /** Existing private input owner; must cancel its pipe/process on signal. No public Graph text. */
 consume:(admission:QaMediaAdmission,metadata:Record<string,any>,content:Buffer,controls:Controls)=>Promise<{state:"imported"|"blocked"|"unknown"}>;
};
function identity(event:any,ctx:any):QaMediaIdentity|null {
 if(!plain(event)||!plain(ctx)||ctx.channelId!=="whatsapp"||!id(ctx.accountId,160)||
   !id(event.messageId)||event.messageId!==ctx.messageId||!id(event.sessionKey,300)||event.sessionKey!==ctx.sessionKey||
   !id(event.from,160)||!id(event.senderId,160)||event.senderId!==ctx.senderId)return null;
 if(event.runId!==undefined&&ctx.runId!==undefined&&event.runId!==ctx.runId)return null;
 const profile=contactRoomSession(ctx.sessionKey);
 // The canonical direct session and sender fact both have to match the People owner at admit().
 if(!profile?.rooms.has("qa")||event.metadata?.senderE164!==profile.e164)return null;
 return Object.freeze({session_key:ctx.sessionKey,message_id:event.messageId,channel_id:"whatsapp",
  account_id:ctx.accountId,from:event.from,sender_id:event.senderId,sender_e164:profile.e164,
  requester_hash:"wa-"+hash(profile.e164).slice(0,16),thread_ref:"contact-room:"+hash(ctx.sessionKey),
  transport_event_id:hash(event.messageId)});
}
function admissionValid(a:QaMediaAdmission|null,i:QaMediaIdentity):a is QaMediaAdmission {
 return !!a&&a.state==="DRAFT"&&id(a.run_id,96)&&/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(a.run_id)&&
  id(a.selected_app_id,64)&&Number.isSafeInteger(a.plan_version)&&a.plan_version>=0&&plain(a.context)&&a.context.schema_version===1&&a.context.owner===false&&
  a.context.access_class==="qa_room"&&a.context.conversation_kind==="direct"&&
  a.context.requester_hash===i.requester_hash&&a.context.transport_event_id===i.transport_event_id&&
  a.context.thread_ref===i.thread_ref&&a.context.selected_app_id===a.selected_app_id&&
  Array.isArray(a.context.grants)&&a.context.grants.length>0&&a.context.grants.length<=12&&
  a.context.grants.some((grant:any)=>plain(grant)&&grant.app_id===a.selected_app_id);
}
/** Inert host preparation: no hook registration, cache, campaign creation, model or sender. */
export async function receiveQaContactMedia(event:any,ctx:any,owners:QaMediaOwners){
 const i=identity(event,ctx);
 if(!i)return {state:"blocked",reason:"qa_media_identity_unavailable",imported:0};
 if(event.mediaStagingPending===true)return {state:"blocked",reason:"qa_media_staging_pending",imported:0};
 if(!Array.isArray(event.media)||!event.media.length)return {state:"ignored",reason:"qa_media_unavailable",imported:0};
 if(event.media.length>MAX_FILES)return {state:"blocked",reason:"qa_media_volume_refused",imported:0};
 const facts=event.media.slice(0,MAX_FILES).map((fact:any)=>plain(fact)?
  {path:fact.path,contentType:fact.contentType,messageId:fact.messageId}:null);
 const controller=new AbortController(),end=performance.now()+10000;
 const timeout=setTimeout(()=>controller.abort(),10000);let imported=0,bytes=0,consuming=false;
 const controls=()=>{const remaining_ms=Math.floor(end-performance.now());if(controller.signal.aborted||remaining_ms<=0)throw Error("deadline");return {signal:controller.signal,remaining_ms};};
 const wait=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{
  if(controller.signal.aborted){void promise.catch(()=>{});reject(Error("deadline"));return;}
  const abort=()=>reject(Error("deadline"));controller.signal.addEventListener("abort",abort,{once:true});
  promise.then(value=>{controller.signal.removeEventListener("abort",abort);try{controls();resolve(value);}catch{reject(Error("deadline"));}},()=>{controller.signal.removeEventListener("abort",abort);reject(Error("owner"));});
 });
 try {
  let admitted=await wait(owners.admit(i,controls()));
  if(!admissionValid(admitted,i))return {state:"blocked",reason:"qa_media_campaign_unavailable",imported};
  const projection=(a:QaMediaAdmission)=>({context:a.context,run_id:a.run_id,selected_app_id:a.selected_app_id,
   plan_version:a.plan_version,dossier_version:a.dossier_version??null});
  const binding=JSON.stringify(projection(admitted));
  const fresh=async()=>{const current=await wait(owners.admit(i,controls()));if(!admissionValid(current,i)||JSON.stringify(projection(current))!==binding)throw Error("authority");admitted=current;};
  const suppliedRoot=await wait(owners.inboundRoot(admitted,controls()));
  if(typeof suppliedRoot!=="string"||!path.isAbsolute(suppliedRoot))throw Error("root");
  const root=await wait(fs.realpath(suppliedRoot));
  for(let index=0;index<facts.length;index++){
   const fact=facts[index];
   if(!plain(fact)||fact.messageId!==i.message_id)throw Error("correlation");
   if(typeof fact.contentType!=="string"||!Object.prototype.hasOwnProperty.call(mimes,fact.contentType))throw Error("type");
   if(typeof fact.path!=="string"||fact.path.length>4096||!path.isAbsolute(fact.path)||/[\0\r\n]/.test(fact.path))throw Error("path");
   const local=path.resolve(fact.path),relative=path.relative(root,local);
   // The installed SDK stages inbound IDs directly in this directory, never an arbitrary descendant.
   if(!relative||path.dirname(local)!==root||relative.startsWith("..")||path.isAbsolute(relative)||await wait(fs.realpath(local))!==local)throw Error("path");
   await fresh();
   // Never race a resource-producing open: even an expired open must close its handle.
   const file=await fs.open(local,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   let content:Buffer;
   try {
    controls();const before=await file.stat();controls();
    if(!before.isFile()||before.nlink!==1||before.size<1||before.size>MAX_BYTES-bytes)throw Error("size");
    content=Buffer.alloc(before.size);let offset=0;
    while(offset<content.length){controls();const read=await file.read(content,offset,Math.min(65536,content.length-offset),offset);if(!read.bytesRead)throw Error("read");offset+=read.bytesRead;}
    const after=await file.stat(),current=await fs.lstat(local);controls();
    if(!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||
      after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||
      current.mtimeMs!==before.mtimeMs||current.ctimeMs!==before.ctimeMs)throw Error("changed");
   }finally{await file.close();}
   bytes+=content.length;
   await fresh();
   const metadata={schema_version:1,transport_event_id:i.transport_event_id,message_id:i.message_id,
    requester_hash:i.requester_hash,app_id:admitted.selected_app_id,name:`QA_Piece_${index+1}.${mimes[fact.contentType]}`,
    mime_type:fact.contentType,size_bytes:content.length,sha256:hash(content)};
   consuming=true;
   const result=await wait(owners.consume(admitted,metadata,content,controls()));
   consuming=false;
   if(result?.state!=="imported")return {state:result?.state==="unknown"?"unknown":"blocked",reason:"qa_media_import_unconfirmed",imported};
   imported++;
  }
  return {state:"imported",reason:null,imported};
 }catch(error:any){
  const reasons:Record<string,string>={deadline:"qa_media_deadline_exceeded",authority:"qa_media_authority_changed",
   root:"qa_media_root_unavailable",correlation:"qa_media_correlation_refused",type:"qa_media_type_unsupported",
   path:"qa_media_path_refused",size:"qa_media_volume_refused",read:"qa_media_source_unavailable",
   changed:"qa_media_source_changed",owner:"qa_media_owner_unavailable"};
  return {state:consuming?"unknown":"blocked",reason:reasons[error?.message]??"qa_media_source_unavailable",imported};
 }
 finally{clearTimeout(timeout);controller.abort();}
}
