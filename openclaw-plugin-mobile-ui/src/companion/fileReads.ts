import {createHash} from "crypto";
import {ControlReadPool} from "./control";
import {callOpenClawGateway} from "./openclawAgentClient";
import {gatewayFileList,gatewayFileContent,type FileReadScope} from "./fileGatewayRead";
import {safeFileName,fileContentAllowed} from "./fileReadBoundary";
const failure=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
const identity=/^[A-Za-z0-9:_+.@-]{1,200}$/;
// Reuse the bounded Control collector; no filesystem, registry or session creation.
const pool=new ControlReadPool(14000,2,8,10*1024*1024);
const pending={success:false,state:"warming",receipt:null,ready:false,retryAfterMs:500,computation:{deliveryMode:"deferred"}};
let mainCache:{at:number;row:{key:string;sessionId:string}|null}|null=null;
let mainFlight:Promise<{key:string;sessionId:string}|null>|undefined;
async function mainSession(deadline:number){
 if(mainCache&&Date.now()-mainCache.at<15000){if(!mainCache.row)throw failure('files_owner_unavailable',503);return mainCache.row;}
 if(!mainFlight){mainFlight=(async()=>{
  try{
   const remaining=Math.min(10000,deadline-Date.now());if(remaining<=0)throw Error();
   const value=await callOpenClawGateway('sessions.list',{search:'agent:main:main',limit:100},{timeoutMs:remaining,hardTimeoutMs:remaining,strictOutput:{stdoutMaxBytes:1024*1024,stderrMaxBytes:65536,killGraceMs:250}});
   if(!Array.isArray(value?.sessions)||value.sessions.length>100)throw Error();
   // The string is only a selector. Dispatch always uses the owner's actual key.
   const found=value.sessions.filter((row:any)=>row?.key==='agent:main:main'&&identity.test(row.key)&&typeof row.sessionId==='string'&&identity.test(row.sessionId));
   const row=found.length===1?{key:found[0].key,sessionId:found[0].sessionId}:null;mainCache={at:Date.now(),row};return row;
  }catch{mainCache={at:Date.now(),row:null};return null;}
 })();}
 let row;try{row=await mainFlight;}finally{mainFlight=undefined;}
 if(!row)throw failure('files_owner_unavailable',503);return row;
}
function query(params:URLSearchParams,content:boolean){
 const allowed=content?["scope","sessionId","path"]:["scope","sessionId","path","search"];
 for(const [key]of params)if(!allowed.includes(key)||params.getAll(key).length!==1)throw failure("invalid_file_query");
 const selected=params.get("scope")||"agent",name=params.get("path")||"",search=params.get('search')??undefined,sessionId=params.get('sessionId');
 if(selected!=="agent"&&selected!=="session")throw failure("invalid_file_query");
 if(content||name)safeFileName(name);if(content)fileContentAllowed(name);
 if(sessionId!==null&&!identity.test(sessionId))throw failure('file_not_available',404);
 if(search!==undefined&&(search.length<1||search.length>160||/[\p{C}]/u.test(search)))throw failure('invalid_file_query');
 if(selected==='agent'&&(sessionId!==null||search!==undefined||!content&&name))throw failure('invalid_file_query');
 return {selected,name,search,sessionId};
}
function key(value:any){return "files-"+createHash("sha256").update(JSON.stringify(value)).digest("hex");}
async function cached(request:ReturnType<typeof query>,content:boolean){
 const resourceKey=key({...request,content});
 const flight=pool.read(resourceKey,async signal=>{
  const deadline=Date.now()+13500;
  let scope:FileReadScope={scope:'agent'};
  if(request.selected==='session'){
   const row=await mainSession(deadline);
   if(request.sessionId!==null&&request.sessionId!==row.sessionId&&request.sessionId!==row.key)throw failure('file_not_available',404);
   scope={scope:'session',sessionKey:row.key};
  }
  if(signal.aborted)throw failure('files_owner_unavailable',503);
  const raw=content?await gatewayFileContent(scope,request.name,{signal,deadline}):await gatewayFileList(scope,request.name,{signal,deadline},request.search);
  if(signal.aborted)throw failure("files_owner_unavailable",503);
  const data=content?{contentType:(raw as any).contentType,contentBase64:(raw as any).bytes.toString("base64"),truncated:(raw as any).truncated,redacted:(raw as any).redacted}:raw;
  return {schemaVersion:2,sections:{files:{schemaVersion:2,resourceKey,computedAt:new Date().toISOString(),dataRevision:key(data),remainingFreshMs:15000,availability:"ready",freshness:"fresh",data}}};
 },undefined,{cache:true}).then(value=>({value}),error=>({error}));
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([flight,new Promise<{pending:true}>(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);}finally{if(timer)clearTimeout(timer);}
}
export async function filesList(parameters:URLSearchParams){
 const request=query(parameters,false),loaded=await cached(request,false);
 if("pending"in loaded)return pending;if("error"in loaded)throw loaded.error;
 const data:any=loaded.value.sections.files.data;
 return {success:true,state:data.ownerTruncated?"partial":"ok",receipt:null,ready:true,installedSchemaQualified:false,items:data.items,truncated:data.ownerTruncated,ownerTruncated:data.ownerTruncated,search:data.search,cursor:null};
}
export async function filesContent(parameters:URLSearchParams){
 const request=query(parameters,true),loaded=await cached(request,true);
 if("pending"in loaded)return pending;if("error"in loaded)throw loaded.error;
 const data:any=loaded.value.sections.files.data;
 return {success:true,state:"ok",receipt:null,ready:true,installedSchemaQualified:false,contentType:data.contentType,bytes:Buffer.from(data.contentBase64,"base64"),truncated:data.truncated,redacted:data.redacted};
}
