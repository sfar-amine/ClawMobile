import fs from "fs";
import path from "path";
import os from "os";
const C=fs.constants, MAX_ENTRIES=10000, MAX_READ=100, MAX_BYTES=262144;
const NAME=/^(companion|app)-[0-9]{8}T[0-9]{6}\.json$/;
const HASH=/^[a-f0-9]{7,40}$/;
const STATES=new Set(["deployed","installed","failed","refused","rolled_back","rollback_failed"]);
export type DeploymentReceiptsView={schemaVersion:1,state:"ok"|"partial"|"unavailable",items:any[],issues:string[]};
let cached:{root:string,until:number,value:DeploymentReceiptsView}|null=null;
let flight:{root:string,promise:Promise<DeploymentReceiptsView>}|null=null;
function iso(value:unknown):string|null{if(typeof value!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value))return null;const n=Date.parse(value);return Number.isFinite(n)?new Date(n).toISOString():null;}
function project(d:any,kind:string):any|null{
 if(!d||typeof d!=="object"||Array.isArray(d)||d.version!==1)return null;
 const state=STATES.has(d.state)?d.state:"unknown",at=iso(d.at);
 if(!at)return null;
 const hash=(v:any)=>typeof v==="string"&&HASH.test(v)?v:null;
 const checks=Array.isArray(d.acceptance?.checks)&&d.acceptance.checks.length<=200?d.acceptance.checks:null;
 const failed=checks?.flatMap((c:any,i:number)=>c?.status==="fail"?[{check:i+1,code:Number.isInteger(c.code)&&c.code>=0&&c.code<=599?c.code:null}]:[])??null;
 const version=kind==="app"&&typeof d.detail==="string"? /^version=([0-9]+(?:\.[0-9]+){1,3}) run=[0-9]{1,20}$/.exec(d.detail):null;
 return {kind,state,target:hash(kind==="app"?d.commit:d.target),previous:kind==="companion"?hash(d.previous):null,at,appVersion:version?.[1]??null,checksCount:checks?.length??null,failedChecks:failed,rollback:state==="unknown"?null:state==="rolled_back"||state==="rollback_failed"};
}
async function collect(root:string):Promise<DeploymentReceiptsView>{
 const issues=new Set<string>(),items:any[]=[];let dir:fs.promises.FileHandle|undefined,parent:fs.promises.FileHandle|undefined,home:fs.promises.FileHandle|undefined;
 try{
  home=await fs.promises.open(path.dirname(path.dirname(root)),C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|C.O_DIRECTORY);
  parent=await fs.promises.open(`/proc/self/fd/${home.fd}/.openclaw`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|C.O_DIRECTORY);
  dir=await fs.promises.open(`/proc/self/fd/${parent.fd}/deploys`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|C.O_DIRECTORY);
  // Anchor children to the opened directory, including when its pathname is replaced.
  const anchored=`/proc/self/fd/${dir.fd}`;const stream=await fs.promises.opendir(anchored);const names:string[]=[];let count=0;
  try{for await(const entry of stream){if(++count>MAX_ENTRIES){issues.add("directory_scan_limit");break;}if(NAME.test(entry.name))names.push(entry.name);}}finally{await stream.close().catch(()=>{});}
  // Filename timestamps are produced by both canonical deployment owners.
  names.sort((a,b)=>b.slice(b.indexOf("-")+1).localeCompare(a.slice(a.indexOf("-")+1)));if(names.length>MAX_READ)issues.add("receipt_read_limit");
  for(const name of names.slice(0,MAX_READ)){
   let file:fs.promises.FileHandle|undefined;
   try{file=await fs.promises.open(path.join(anchored,name),C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);const stat=await file.stat();if(!stat.isFile()||stat.size>MAX_BYTES){issues.add("receipt_unavailable");continue;}
    const bytes=Buffer.alloc(MAX_BYTES+1);const {bytesRead}=await file.read(bytes,0,bytes.length,0);if(bytesRead>MAX_BYTES){issues.add("receipt_unavailable");continue;}
    const row=project(JSON.parse(bytes.subarray(0,bytesRead).toString("utf8")),name.startsWith("app-")?"app":"companion");if(row)items.push(row);else issues.add("receipt_invalid");
   }catch{issues.add("receipt_unavailable");}finally{await file?.close();}
  }
  items.sort((a,b)=>b.at.localeCompare(a.at));
  return {schemaVersion:1,state:issues.size?"partial":"ok",items,issues:[...issues]};
 }catch{return {schemaVersion:1,state:"unavailable",items:[],issues:["deployments_owner_unavailable"]};}finally{await dir?.close();await parent?.close();await home?.close();}
}
async function snapshot():Promise<DeploymentReceiptsView>{
 const root=path.join(process.env.SAMANTHA_CONTROL_HOME||os.homedir(),".openclaw/deploys");
 if(cached?.root===root&&cached.until>Date.now())return cached.value;
 if(flight?.root===root)return flight.promise;
 const promise=collect(root).then(value=>{cached={root,until:Date.now()+1000,value};return value;});flight={root,promise};
 try{return await promise;}finally{if(flight?.promise===promise)flight=null;}
}
export async function readDeploymentReceipts(limit=20):Promise<DeploymentReceiptsView>{const value=await snapshot();return {...value,items:value.items.slice(0,limit)};}
export async function latestCompanionDeploymentAt(target:string):Promise<string|null>{
 if(!HASH.test(target))return null;const value=await snapshot();if(value.state!=="ok")return null;
 const matches=value.items.filter(x=>x.kind==="companion"&&x.state==="deployed"&&x.target&&(x.target.startsWith(target)||target.startsWith(x.target)));
 if(new Set(matches.map(x=>x.target)).size!==1)return null;return matches[0]?.at??null;
}
