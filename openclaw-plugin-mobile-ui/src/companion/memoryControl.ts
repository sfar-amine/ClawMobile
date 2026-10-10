import {execFile} from "child_process";
import path from "path";
import os from "os";
const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
const owner=()=>process.env.SAMANTHA_MEMORY_OWNER||path.join(os.homedir(),"ClawMobile/installer/termux-lite/context-store.py");
async function callOwner(args:string[],body?:any):Promise<any>{
 return new Promise((resolve,reject)=>{
  const child=execFile("python3",[owner(),...args],{timeout:5000,maxBuffer:262144},(error,stdout)=>{
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
 if(preview.previewHash!==body.previewHash||body.selectedIds.some((id:string)=>!preview.items?.some((row:any)=>row.id===id)))throw nativeError("memory_preview_changed",409);
 const checked=await callOwner(['control-import-check'],body);
 if(checked.state!=="not_found")return checked;
 try{return await callOwner(['control-import'],body);}
 catch{
  const observed=await callOwner(['control-import-check'],body).catch(()=>null);
  return observed?.state==='imported'?observed:{success:false,state:'indeterminate',receipt:null};
 }
}
