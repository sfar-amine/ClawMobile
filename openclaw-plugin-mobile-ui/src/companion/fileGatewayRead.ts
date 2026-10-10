import pathModule from "path";
import {callOpenClawGateway} from "./openclawAgentClient";
import {safeFileName,boundedFileContent,fileContentAllowed} from "./fileReadBoundary";

// Closed read schemas transcribed from public OpenClaw 2026.9.6; not a deployed capture.
const error=()=>Object.assign(new Error("file_owner_unavailable"),{statusCode:503});
const unavailable=()=>Object.assign(new Error("file_not_available"),{statusCode:404});
const agentNames=new Set(["AGENTS.md","SOUL.md","USER.md","IDENTITY.md","DREAMS.md"]);
function object(value:any,keys:string[],required:string[]){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||required.some(k=>!(k in value)))throw error();}
function string(value:any){if(typeof value!=="string"||!value||value.length>4096)throw error();}
function entry(value:any,agent:boolean,content:boolean){
 const keys=agent?["name","path","missing","expectedAbsent","size","updatedAtMs","hash",...(content?["content"]:[])]:["path","workspacePath","name","kind","missing","size","updatedAtMs","hash","mimeType","contentEncoding","previewKind",...(content?["content"]:[])];
 object(value,keys,["name","path","missing",...(!agent?["kind"]:[])]);string(value.name);string(value.path);
 if(typeof value.missing!=="boolean"||("expectedAbsent"in value&&typeof value.expectedAbsent!=="boolean"))throw error();
 for(const key of ["size","updatedAtMs"])if(key in value&&(!Number.isSafeInteger(value[key])||value[key]<0||(key==="updatedAtMs"&&value[key]>8640000000000000)))throw error();
 if("hash"in value&&(typeof value.hash!=="string"||!/^[a-fA-F0-9]{64}$/.test(value.hash)))throw error();
 if("content"in value&&(typeof value.content!=="string"||Buffer.byteLength(value.content)>8*1024*1024))throw error();
 if(!agent){if(!["read","modified"].includes(value.kind))throw error();for(const key of ["workspacePath","mimeType"])if(key in value)string(value[key]);if("contentEncoding"in value&&!["utf8","base64"].includes(value.contentEncoding))throw error();if("previewKind"in value&&!["text","image","unsupported"].includes(value.previewKind))throw error();}
 return value;
}
function visible(path:string){try{safeFileName(path);return true;}catch{return false;}}
function projected(name:string,path:string,kind:string,row:any){return {name,kind:kind==="directory"?"dir":"file",size:row.size??null,modifiedAt:row.updatedAtMs===undefined?null:new Date(row.updatedAtMs).toISOString(),previewable:kind!=="directory"&&/\.(?:txt|md|markdown|png|jpe?g)$/i.test(name)&&(()=>{try{fileContentAllowed(path);return true;}catch{return false;}})()};}
export type FileReadScope={scope:"agent"}|{scope:"session";sessionKey:string};
function request(scope:FileReadScope,path:string,get:boolean){
 if(scope.scope==="agent"){if(!get&&path)throw unavailable();if(path&&(!agentNames.has(path)||!visible(path)))throw unavailable();return {method:get?"agents.files.get":"agents.files.list",params:{agentId:"main",...(get?{name:path}:{})}};}
 if(scope.scope!=="session"||!/^agent:main:companion-chat-[A-Za-z0-9_-]{1,100}$/.test(scope.sessionKey))throw unavailable();
 if(path)safeFileName(path);
 return {method:get?"sessions.files.get":"sessions.files.list",params:{sessionKey:scope.sessionKey,agentId:"main",path}};
}
type ReadBounds={signal?:AbortSignal;deadline?:number};
async function read(method:string,params:any,bounds:ReadBounds={}){
 const remaining=bounds.deadline===undefined?12000:bounds.deadline-Date.now();
 if(bounds.signal?.aborted||remaining<1)throw error();
 try{return await callOpenClawGateway(method,params,{timeoutMs:Math.min(10000,remaining),hardTimeoutMs:Math.min(12000,remaining),strictOutput:{stdoutMaxBytes:9*1024*1024,stderrMaxBytes:64*1024,killGraceMs:250}});}catch{throw error();}
}
export async function gatewayFileList(scope:FileReadScope,path="",bounds:ReadBounds={}){
 const q=request(scope,path,false),value=await read(q.method,q.params,bounds);
 let rows:any[],ownerTruncated=false;
 if(scope.scope==="agent"){
  object(value,["agentId","workspace","files"],["agentId","workspace","files"]);if(value.agentId!=="main")throw error();string(value.workspace);
  if(!Array.isArray(value.files)||value.files.length>100)throw error();rows=value.files.map((r:any)=>{entry(r,true,false);if(r.path!==value.workspace.replace(/\/$/,"")+"/"+r.name)throw error();return r;}).filter((r:any)=>!r.missing&&agentNames.has(r.name)&&visible(r.name)).map((r:any)=>projected(r.name,r.name,"file",r));
 }else{
  object(value,["sessionKey","root","gitCheckout","files","browser"],["sessionKey","files"]);if(value.sessionKey!==scope.sessionKey||!Array.isArray(value.files)||value.files.length>2000)throw error();if("root"in value)string(value.root);if("gitCheckout"in value&&typeof value.gitCheckout!=="boolean")throw error();value.files.forEach((r:any)=>entry(r,false,false));
  const b=value.browser;object(b,["path","parentPath","search","entries","truncated"],["path","entries"]);if(("parentPath"in b&&typeof b.parentPath!=="string")||b.path!==path||("search"in b)||!Array.isArray(b.entries)||b.entries.length>250||("truncated"in b&&typeof b.truncated!=="boolean"))throw error();
  rows=b.entries.map((r:any)=>{object(r,["path","name","kind","sessionKind","size","updatedAtMs"],["path","name","kind"]);string(r.name);string(r.path);if(!["file","directory"].includes(r.kind)||("sessionKind"in r&&!["read","modified","mixed"].includes(r.sessionKind)))throw error();for(const k of ["size","updatedAtMs"])if(k in r&&(!Number.isSafeInteger(r[k])||r[k]<0||(k==="updatedAtMs"&&r[k]>8640000000000000)))throw error();const expected=path?path+"/"+r.name:r.name;if(r.path!==expected||r.name.includes("/"))throw error();return visible(r.path)?projected(r.name,r.path,r.kind,r):null;}).filter(Boolean);ownerTruncated=b.truncated===true;
 }
 return {items:rows,ownerTruncated,source:"gateway",installedSchemaQualified:false};
}
export async function gatewayFileContent(scope:FileReadScope,path:string,bounds:ReadBounds={}){
 fileContentAllowed(path);const q=request(scope,path,true);
 let canonicalRoot:string|undefined;
 if(scope.scope==="session"){
  const parent=path.includes("/")?path.slice(0,path.lastIndexOf("/")):"";
  const [catalog,agentCatalog]=await Promise.all([read("sessions.files.list",{sessionKey:scope.sessionKey,agentId:"main",path:parent},bounds),read("agents.files.list",{agentId:"main"},bounds)]);
  object(agentCatalog,["agentId","workspace","files"],["agentId","workspace","files"]);string(agentCatalog.workspace);
  if(agentCatalog.agentId!=="main"||!Array.isArray(agentCatalog.files)||agentCatalog.files.length>100)throw error();agentCatalog.files.forEach((f:any)=>entry(f,true,false));
  object(catalog,["sessionKey","root","gitCheckout","files","browser"],["sessionKey","root","files","browser"]);string(catalog.root);
  if(catalog.sessionKey!==scope.sessionKey||!Array.isArray(catalog.files)||catalog.files.length>2000||("gitCheckout"in catalog&&typeof catalog.gitCheckout!=="boolean"))throw error();
  const root=catalog.root,anchor=agentCatalog.workspace;
  if(!root.startsWith("/")||!anchor.startsWith("/")||pathModule.posix.normalize(root)!==root||pathModule.posix.normalize(anchor)!==anchor||/[\\\x00-\x1f]/.test(root)||/[\\\x00-\x1f]/.test(anchor)||!(root===anchor||root.startsWith(anchor+"/")))throw unavailable();
  if(root!==anchor)safeFileName(root.slice(anchor.length+1));
  for(const f of catalog.files){entry(f,false,false);if(f.path===path||f.workspacePath===path){if(f.workspacePath!==path)throw unavailable();fileContentAllowed(f.workspacePath);}}
  const b=catalog.browser;object(b,["path","parentPath","search","entries","truncated"],["path","entries"]);
  if(("parentPath"in b&&typeof b.parentPath!=="string")||("truncated"in b&&typeof b.truncated!=="boolean")||b.path!==parent||("search"in b)||!Array.isArray(b.entries)||b.entries.length>250)throw error();
  let matched=false;
  for(const f of b.entries){object(f,["path","name","kind","sessionKind","size","updatedAtMs"],["path","name","kind"]);string(f.path);string(f.name);if(!["file","directory"].includes(f.kind)||("sessionKind"in f&&!["read","modified","mixed"].includes(f.sessionKind)))throw error();for(const k of ["size","updatedAtMs"])if(k in f&&(!Number.isSafeInteger(f[k])||f[k]<0||f[k]>8640000000000000))throw error();if(f.path===(parent?parent+"/":"")+f.name&&f.path===path&&f.name===path.split("/").pop()&&f.kind==="file")matched=true;}
  if(!matched)throw unavailable();canonicalRoot=root;q.params.path=root+"/"+path;
 }
 const value=await read(q.method,q.params,bounds);
 const agent=scope.scope==="agent";object(value,agent?["agentId","workspace","file"]:["sessionKey","root","file"],agent?["agentId","workspace","file"]:["sessionKey","file"]);
 if(agent?(value.agentId!=="main"):(value.sessionKey!==(scope as any).sessionKey))throw error();
 const file=entry(value.file,agent,true);
 if(file.missing||file.name!==path.split("/").pop()||(!agent&&(file.workspacePath!==path||![path,canonicalRoot+"/"+path].includes(file.path)))||file.previewKind==="unsupported"||typeof file.content!=="string")throw unavailable();
 if(agent){string(value.workspace);if(file.path!==value.workspace.replace(/\/$/,"")+"/"+path)throw error();}
 let bytes:Buffer;
 if(file.contentEncoding==="base64"){
  if(file.previewKind!=="image"||!["image/png","image/jpeg"].includes(file.mimeType)||!/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))throw error();
  bytes=Buffer.from(file.content,"base64");if(bytes.toString("base64")!==file.content)throw error();
 }else{if(!agent&&file.contentEncoding!=="utf8")throw error();bytes=Buffer.from(file.content);}
 const preview=boundedFileContent(path,bytes);
 if(file.previewKind==="image"&&preview.contentType!==file.mimeType)throw unavailable();
 return {...preview,installedSchemaQualified:false,headers:{"X-Content-Type-Options":"nosniff"}};
}
