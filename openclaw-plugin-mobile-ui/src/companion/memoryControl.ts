import {runtimeFile} from "../runtimeRoot";
import {execFile} from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
const owner=()=>process.env.SAMANTHA_MEMORY_OWNER||runtimeFile("context-store.py");
async function callOwner(args:string[],body?:any):Promise<any>{
 return new Promise((resolve,reject)=>{
  const child=execFile("python3",[owner(),...args],{timeout:5000,maxBuffer:2*1024*1024},(error,stdout)=>{
   try{
    const failed=JSON.parse(stdout);
    if(failed?.success===false&&failed.state==="failed"&&failed.receipt===null&&failed.error==="memory_import_unavailable"&&(!error||(error as any).code===1)){resolve({success:false,state:"failed",receipt:null,error:"memory_import_unavailable"});return;}
   }catch{}
   if(error){reject(nativeError("memory_owner_unavailable",503));return;}
   try{const value=JSON.parse(stdout);if(value.error&&value.state!=="conflict")throw Error();resolve(value);}catch{reject(nativeError("memory_owner_unavailable",503));}
  });
  if(body!==undefined){child.stdin?.on('error',()=>{});child.stdin?.end(JSON.stringify(body));}
 });
}
export async function memoryRead(parameters:URLSearchParams){
 for(const [key]of parameters)if(!["q","kind","offset","limit"].includes(key)||parameters.getAll(key).length!==1)throw nativeError("invalid_memory_query");
 const q=parameters.get("q")||"",kind=parameters.get("kind")||"",offset=parameters.get("offset")||"0",limit=parameters.get("limit")||"20";
 if(q.length>200||!["","preference","decision","person","rule","import"].includes(kind)||!/^\d{1,4}$/.test(offset)||!/^\d{1,2}$/.test(limit)||Number(offset)>5000||Number(limit)<1||Number(limit)>50)throw nativeError("invalid_memory_query");
 const value=await callOwner(["control-list",q,kind,offset,limit]);if(!Array.isArray(value.items)||value.items.length>50)throw nativeError("memory_owner_unavailable",503);
 return value;
}
export async function memoryForget(id:string,body:any){
 if(!/^[a-f0-9]{64}$/.test(id)||!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==1||typeof body.operationId!=="string"||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId))throw nativeError("invalid_memory_operation");
 const op=body.operationId,checked=await callOwner(["control-forget-check",id,op]);
 if(checked.state!=="ready")return checked;
 try{return await callOwner(["control-forget",id,op]);}
 catch{
  // One read after uncertainty, never redispatch the write.
  const observed=await callOwner(["control-forget-check",id,op]).catch(()=>null);
  return observed?.state==="forgotten"?observed:{success:false,state:"indeterminate",receipt:null};
 }
}
export async function memoryImport(body:any,commit:boolean){
 const expected=commit?['source','export','previewHash','selectedIds','operationId']:['source','export'];
 if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).sort().join()!==expected.sort().join()||!['chatgpt','claude'].includes(body.source)||!Array.isArray(body.export)||body.export.length>50||Buffer.byteLength(JSON.stringify(body))>1024*1024)throw nativeError("invalid_memory_import");
 if(commit&&(typeof body.operationId!=="string"||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId)||typeof body.previewHash!=="string"||!/^[a-f0-9]{64}$/.test(body.previewHash)||!Array.isArray(body.selectedIds)||body.selectedIds.length<1||body.selectedIds.length>20||new Set(body.selectedIds).size!==body.selectedIds.length||body.selectedIds.some((id:any)=>typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id))))throw nativeError("invalid_memory_import");
 if(!commit)return callOwner(['control-import-preview'],body);
 // Recompute preview before the mutation: no stale or unreviewed selection is accepted.
 const preview=await callOwner(['control-import-preview'],{source:body.source,export:body.export});
 if(preview.state==='failed')return preview;
 if(preview.previewHash!==body.previewHash||body.selectedIds.some((id:string)=>!preview.items?.some((row:any)=>row.id===id)))throw nativeError("memory_preview_changed",409);
 const checked=await callOwner(['control-import-check'],body);
 if(checked.state!=="not_found")return checked;
 try{return await callOwner(['control-import'],body);}
 catch{
  const observed=await callOwner(['control-import-check'],body).catch(()=>null);
  return observed?.state==='imported'?observed:{success:false,state:'indeterminate',receipt:null};
 }
}
// M2 « retiens ça » : one durable fact through the canonical writer context-event.sh
// (closed surfaces/kinds, secret filter, content-addressed id, SQLite ingestion).
// No store of its own; idempotence per action_key is the Remote Bridge receipt.
export const REMEMBER_SURFACES=["claude","codex","chat","app","voice"] as const;
export const REMEMBER_KINDS=["decision","learning","constraint","open_thread","completed_action"] as const;
export const REMEMBER_MAX_CHARS=1000;
const contextEventWriters=(home=os.homedir())=>[
 String(process.env.SAMANTHA_CONTEXT_EVENT||"").trim(),
 runtimeFile("context-event.sh", home),
].filter(Boolean);
const TRANSCRIPT_ROLE=/^\s*(?:user|assistant|human|system|ai|claude|chatgpt|codex|amine|samantha)\s*:/gim;
export function validateRemember(params:Record<string,unknown>){
 const surface=String(params.surface||""),kind=String(params.kind||""),text=typeof params.text==="string"?params.text.trim():"";
 const supersedes=params.supersedes===undefined||params.supersedes===null||params.supersedes===""?"":String(params.supersedes);
 if(!(REMEMBER_SURFACES as readonly string[]).includes(surface))throw nativeError("invalid_remember_surface");
 if(!(REMEMBER_KINDS as readonly string[]).includes(kind))throw nativeError("invalid_remember_kind");
 if(supersedes&&!/^[0-9a-f]{64}$/.test(supersedes))throw nativeError("invalid_remember_supersedes");
 if(!text||text.length>REMEMBER_MAX_CHARS||text.startsWith("--"))throw nativeError("invalid_remember_text");
 // A durable fact is a short statement, never a pasted conversation.
 if(text.split("\n").length>6||(text.match(TRANSCRIPT_ROLE)||[]).length>=2)throw nativeError("remember_transcript_refused");
 return {surface,kind,text,supersedes};
}
export async function memoryRemember(params:Record<string,unknown>){
 const {surface,kind,text,supersedes}=validateRemember(params);
 const writer=contextEventWriters().find((candidate)=>{try{return fs.statSync(candidate).isFile();}catch{return false;}});
 if(!writer)throw nativeError("memory_owner_unavailable",503);
 const argv=[writer,surface,kind,...(supersedes?["--supersedes",supersedes]:[]),text];
 return new Promise<Record<string,unknown>>((resolve,reject)=>{
  execFile("bash",argv,{timeout:10_000,maxBuffer:64*1024},(error,stdout)=>{
   const code=(error as any)?.code;
   // context-event.sh exits 65 on its secret/payment filter: nothing was written.
   if(code===65){resolve({state:"refused",reason:"secret_like_text",surface,kind,written:false});return;}
   if(code===64){reject(nativeError("invalid_remember_event"));return;}
   const eventId=String(stdout||"").trim().split("\n").pop()||"";
   if(error||!/^[0-9a-f]{64}$/.test(eventId)){reject(nativeError("memory_owner_unavailable",503));return;}
   resolve({state:"recorded",event_id:eventId,surface,kind,...(supersedes?{supersedes}:{}),chars:text.length,written:true});
  });
 });
}
