import fs from "fs/promises";
import {constants} from "fs";
import path from "path";
import os from "os";
import {createHash} from "crypto";
import {ControlReadPool} from "./control";
import {gatewayFileList,gatewayFileContent,type FileReadScope} from "./fileGatewayRead";
import {safeFileName,fileContentAllowed,FILE_LIST_LIMIT} from "./fileReadBoundary";
import {protectedJob} from "./automations";
import {protectedRun} from "./runInactivity";
import {expectedCompanionSessionKey,normalizeCompanionSessionId} from "./openclawAgentClient";
const failure=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
// RAM cache owned by the read facade: bounded keys/bytes/concurrency, no canonical store.
const pool=new ControlReadPool(26000,2,8,10*1024*1024);
const pending={success:false,state:"warming",receipt:null,ready:false,installedSchemaQualified:false,retryAfterMs:500};
async function scopeFromQuery(params:URLSearchParams,content:boolean){
 const allowed=content?["scope","sessionId","path"]:["scope","sessionId","path","cursor"];
 for(const [key]of params)if(!allowed.includes(key)||params.getAll(key).length!==1)throw failure("invalid_file_query");
 const selected=params.get("scope")||"agent",name=params.get("path")||"";
 if(selected!=="agent"&&selected!=="session")throw failure("invalid_file_query");
 if(content||name)safeFileName(name);if(content)fileContentAllowed(name);
 if(selected==="agent"){if(params.has("sessionId"))throw failure("invalid_file_query");return {scope:{scope:"agent"} as FileReadScope,name};}
 const sessionId=params.get("sessionId")||"";
 if(!/^[A-Za-z0-9-]{1,100}$/.test(sessionId)||normalizeCompanionSessionId(sessionId)!==sessionId)throw failure("file_not_available",404);
 const directory=path.join(process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),".openclaw"),"clawmobile-companion");
 let store:any;
 try{
  const d=await fs.lstat(directory);if(!d.isDirectory()||d.isSymbolicLink())throw Error();
  const file=await fs.open(path.join(directory,"runs.json"),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw Error();const buffer=Buffer.alloc(8*1024*1024+1);let total=0;while(total<buffer.length){const read=await file.read(buffer,total,buffer.length-total,null);if(!read.bytesRead)break;total+=read.bytesRead;}if(total>8*1024*1024)throw Error();const after=await file.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error();store=JSON.parse(buffer.subarray(0,total).toString("utf8"));}finally{await file.close();}
  if(!Array.isArray(store.runs)||!Array.isArray(store.paymentRequests)||!Array.isArray(store.ownerConfirmations)||store.runs.length>20000)throw Error();
 }catch{throw failure("file_not_available",404);}
 const rows=store.runs.filter((r:any)=>r?.sessionId===sessionId&&r.executionSource!=="capability_first"&&r.modality!=="voice"&&!(store.archivedSessionIds||[]).includes(sessionId)&&!(store.runDeletions||[]).some((d:any)=>d.runId===r.runId));
 const expected=expectedCompanionSessionKey(sessionId);
 if(!expected.startsWith("agent:main:")||!rows.length||rows.some((r:any)=>(r.sessionKey||expected)!==expected||protectedRun(r,store.paymentRequests,store.ownerConfirmations)||protectedJob({text:r.text,userText:r.userText,decision:r.decision})))throw failure("file_not_available",404);
 return {scope:{scope:"session",sessionKey:expected} as FileReadScope,name};
}
function key(scope:FileReadScope,name:string,content:boolean){return "files-"+createHash("sha256").update(JSON.stringify({scope,name,content})).digest("hex");}
async function cached(scope:FileReadScope,name:string,content:boolean){
 const deadline=Date.now()+24000;
 const flight=pool.read(key(scope,name,content),async signal=>{
  const raw=content?await gatewayFileContent(scope,name,{signal,deadline}):await gatewayFileList(scope,name,{signal,deadline});
  if(signal.aborted)throw failure("file_owner_unavailable",503);
  const data=content?{contentType:(raw as any).contentType,contentBase64:(raw as any).bytes.toString("base64"),truncated:(raw as any).truncated,redacted:(raw as any).redacted}:raw;
  return {schemaVersion:2,sections:{files:{schemaVersion:2,resourceKey:key(scope,name,content),computedAt:new Date().toISOString(),dataRevision:createHash("sha256").update(JSON.stringify(data)).digest("hex"),remainingFreshMs:15000,availability:"ready",freshness:"fresh",data}}};
 },undefined,{cache:true}).then(value=>({value}),()=>({error:true}));
 let timer:any;
 try{return await Promise.race([flight,new Promise<{pending:true}>(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);}finally{clearTimeout(timer);}
}
export async function filesList(parameters:URLSearchParams){
 const {scope,name}=await scopeFromQuery(parameters,false),cursor=parameters.get("cursor");
 if(cursor&&!/^[a-f0-9]{64}\.[0-9]{1,3}$/.test(cursor))throw failure("invalid_file_cursor");
 const loaded=await cached(scope,name,false);
 if("pending"in loaded)return pending;if("error"in loaded)throw failure("file_owner_unavailable",503);
 const section=loaded.value.sections.files,data:any=section.data;
 const revision=createHash("sha256").update(key(scope,name,false)+"|"+section.dataRevision).digest("hex");
 const offset=cursor?Number(cursor.split(".")[1]):0;
 if(cursor&&(cursor.split(".")[0]!==revision||offset%FILE_LIST_LIMIT!==0||offset>=data.items.length))throw failure("file_cursor_changed",409);
 const items=data.items.slice(offset,offset+FILE_LIST_LIMIT),next=offset+items.length;
 return {success:true,state:data.ownerTruncated?"partial":"ok",receipt:null,ready:false,installedSchemaQualified:false,items,cursor:next<data.items.length?revision+"."+next:null,ownerTruncated:data.ownerTruncated};
}
export async function filesContent(parameters:URLSearchParams){
 const {scope,name}=await scopeFromQuery(parameters,true),loaded=await cached(scope,name,true);
 if("pending"in loaded)return pending;if("error"in loaded)throw failure("file_owner_unavailable",503);
 const data:any=loaded.value.sections.files.data;
 return {success:true,state:"ok",receipt:null,ready:false,installedSchemaQualified:false,contentType:data.contentType,bytes:Buffer.from(data.contentBase64,"base64"),truncated:data.truncated,redacted:data.redacted};
}
