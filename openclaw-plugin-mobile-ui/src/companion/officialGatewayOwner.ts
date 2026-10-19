/** Official SDK owner adapter; credential/config readers and protocol remain OpenClaw-owned. */
import fs from "fs/promises";
import {constants as fsConstants} from "fs";
import path from "path";
import {pathToFileURL} from "url";
import {createRequire} from "module";
import {createHash} from "crypto";
import type {Readable} from "stream";
import type {GatewayClientOwner,GatewayCallbacks} from "./persistentGatewayTransport";

const sdkNames=["gateway-runtime","config-runtime","gateway-config-runtime","secret-ref-runtime"] as const;
const nativeImport=new Function("specifier","return import(specifier)") as (specifier:string)=>Promise<any>;
const fixedError=(code:string)=>Object.assign(new Error(code),{code,requestSent:false});
const plain=(v:any)=>v!==null&&typeof v==="object"&&!Array.isArray(v);
// Reduced union needed by current Companion callers; not a reproduction of per-method CLI scopes.
// Installed handshake/scopes still require sanitized S24 confirmation before qualification.
export const COMPANION_OPERATOR_SCOPES=Object.freeze(["operator.admin","operator.read","operator.write","operator.approvals"]);

async function selectedBinaryPath(binary:string):Promise<string>{
 if(typeof binary!=="string"||!binary||binary.includes("\0"))throw fixedError("gateway_sdk_config_refused");
 if(binary.includes(path.sep))return fs.realpath(path.resolve(binary));
 for(const directory of (process.env.PATH||"").split(path.delimiter)){
  if(!directory)continue;
  try{const candidate=path.resolve(directory,binary);await fs.access(candidate,1);return await fs.realpath(candidate);}catch{}
 }
 throw fixedError("ENOENT");
}
async function ownerPackageRoot(start:string):Promise<string>{
 let current=path.dirname(start);
 for(let depth=0;depth<8;depth++){
  try{const metadata=JSON.parse(await fs.readFile(path.join(current,"package.json"),"utf8"));if(metadata?.name==="openclaw")return current;}catch{}
  const parent=path.dirname(current);if(parent===current)break;current=parent;
 }
 throw fixedError("ENOENT");
}
/** Discover only the installed package selected by module resolution or the existing CLI binary. */
async function officialSdkPackageRoot(binary:string):Promise<string>{
 let entry:string;
 try{entry=require.resolve("openclaw/plugin-sdk/gateway-runtime");}
 catch{
  let root:string;try{root=await ownerPackageRoot(await selectedBinaryPath(binary));}catch(e:any){if(e?.code==="ENOENT")throw fixedError("ENOENT");throw fixedError("gateway_sdk_unavailable");}
  try{entry=createRequire(path.join(root,"package.json")).resolve("openclaw/plugin-sdk/gateway-runtime");}catch{throw fixedError("ENOENT");}
 }
 const root=await ownerPackageRoot(entry);
 let metadata:any;try{metadata=JSON.parse(await fs.readFile(path.join(root,"package.json"),"utf8"));}catch{throw fixedError("gateway_sdk_unavailable");}
 if(metadata.version!=="2026.9.6")throw fixedError("gateway_sdk_version_unsupported");
 return root;
}
export async function loadOfficialGatewaySdk(binary:string):Promise<any>{
 const root=await officialSdkPackageRoot(binary);
 try{
  const modules=await Promise.all(sdkNames.map(name=>nativeImport(pathToFileURL(createRequire(path.join(root,"package.json")).resolve("openclaw/plugin-sdk/"+name)).href)));
  const [gateway,configuration,ports,secrets]=modules;
  if(typeof gateway.GatewayClient!=="function"||typeof gateway.resolveGatewayAuth!=="function"||typeof configuration.loadConfig!=="function"||typeof configuration.coerceSecretRef!=="function"||typeof ports.resolveGatewayPort!=="function"||typeof secrets.resolveSecretRefValues!=="function")throw Error();
  return {GatewayClient:gateway.GatewayClient,resolveGatewayAuth:gateway.resolveGatewayAuth,loadConfig:configuration.loadConfig,coerceSecretRef:configuration.coerceSecretRef,resolveSecretRefValues:secrets.resolveSecretRefValues,resolveGatewayPort:ports.resolveGatewayPort};
 }catch{throw fixedError("gateway_sdk_unavailable");}
}

/** The deliberately supported target is the configured local, non-TLS shared-auth Gateway only. */
export function officialGatewayConnection(sdk:any,config:any,env:NodeJS.ProcessEnv=process.env){
 if(!plain(config)||config.gateway!==undefined&&!plain(config.gateway))throw fixedError("gateway_sdk_config_refused");
 const gateway=config.gateway||{},authentication=gateway.auth||{};
 if(!plain(authentication)||gateway.mode!==undefined&&gateway.mode!=="local"||gateway.tls?.enabled===true||env.OPENCLAW_GATEWAY_URL?.trim())throw fixedError("gateway_sdk_target_refused");
 // SDK resolveGatewayAuth does not resolve SecretRef values. Do not implement a second credential planner.
 try{
  for(const value of [authentication.token,authentication.password]){
   if(value!==undefined&&(typeof value!=="string"||sdk.coerceSecretRef(value,config.secrets?.defaults)))throw fixedError("gateway_sdk_auth_refused");
  }
 }catch{throw fixedError("gateway_sdk_auth_refused");}
 if(authentication.mode!==undefined&&!["none","token","password"].includes(authentication.mode))throw fixedError("gateway_sdk_auth_refused");
 let auth:any,port:any;try{auth=sdk.resolveGatewayAuth({authConfig:authentication,env,tailscaleMode:gateway.tailscale?.mode});port=sdk.resolveGatewayPort(config,env);}catch{throw fixedError("gateway_sdk_config_refused");}
 if(!plain(auth)||!["none","token","password"].includes(auth.mode)||auth.mode==="token"&&!(typeof auth.token==="string"&&auth.token.trim())||auth.mode==="password"&&!(typeof auth.password==="string"&&auth.password.trim()))throw fixedError("gateway_sdk_auth_refused");
 if(!Number.isInteger(port)||port<1||port>65535)throw fixedError("gateway_sdk_target_refused");
 return {url:"ws://127.0.0.1:"+port,token:auth.token,password:auth.password,deviceIdentity:null,clientName:"cli",mode:"cli",role:"operator",caps:[],minProtocol:4,maxProtocol:4,scopes:[...COMPANION_OPERATOR_SCOPES],hostDeps:{logDebug:()=>{},logError:()=>{},redactForLog:()=>""}};
}

/** Resolve only Gateway auth fields using OpenClaw's existing SecretRef owner; never persist or log them. */
export async function resolveOfficialGatewayConfig(sdk:any,config:any,env:NodeJS.ProcessEnv=process.env){
 if(!plain(config)||!plain(config.gateway||{})||!plain(config.gateway?.auth||{}))throw fixedError("gateway_sdk_config_refused");
 const gateway=config.gateway||{};
 if(gateway.mode!==undefined&&gateway.mode!=="local"||gateway.tls?.enabled===true||env.OPENCLAW_GATEWAY_URL?.trim())throw fixedError("gateway_sdk_target_refused");
 const auth={...(gateway.auth||{})};
 if(auth.mode!==undefined&&!["none","token","password"].includes(auth.mode))throw fixedError("gateway_sdk_auth_refused");
 const fields=auth.mode==="none"?[]:auth.mode==="token"?["token"]:auth.mode==="password"?["password"]:["token","password"];
 for(const field of fields){
  try{
   const ref=sdk.coerceSecretRef(auth[field],config.secrets?.defaults);
   if(ref){
    const values=await sdk.resolveSecretRefValues([ref],{config,env});
    if(!(values instanceof Map)||values.size!==1)throw fixedError("gateway_sdk_auth_refused");
    const value=values.values().next().value;
    if(typeof value!=="string"||!value.trim())throw fixedError("gateway_sdk_auth_refused");
    auth[field]=value;
   }else if(auth[field]!==undefined&&typeof auth[field]!=="string")throw fixedError("gateway_sdk_auth_refused");
  }catch{throw fixedError("gateway_sdk_auth_refused");}
 }
 // Unused references are omitted, not resolved or passed to the synchronous auth planner.
 for(const field of ["token","password"])if(!fields.includes(field))delete auth[field];
 return {...config,gateway:{...gateway,auth}};
}

/** Async initialization behind the synchronous owner interface; hello, never socket state, gates requests. */
export function createOfficialGatewayOwner(callbacks:GatewayCallbacks,binary:string=process.env.CLAWMOBILE_OPENCLAW_BIN||"openclaw",loader:(binary:string)=>Promise<any>=loadOfficialGatewaySdk):GatewayClientOwner{
 let stopped=false,started=false,ready=false,client:any;
 return {
  get connected(){return ready&&!stopped&&client?.connected===true;},
  start(){
   if(started||stopped)return;started=true;
   void (async()=>{
    try{
     const sdk=await loader(binary);if(stopped)return;
     let config:any;try{config=await sdk.loadConfig();}catch{throw fixedError("gateway_sdk_config_refused");}
     if(stopped)return;
     const resolvedConfig=await resolveOfficialGatewayConfig(sdk,config);
     if(stopped)return;
     const options=officialGatewayConnection(sdk,resolvedConfig);
     client=new sdk.GatewayClient({...options,
      onHelloOk:()=>{if(stopped)return;ready=true;callbacks.onHelloOk();},
      onClose:(code:number)=>{ready=false;if(!stopped)callbacks.onClose(code);},
      onConnectError:(error:any)=>{ready=false;if(!stopped)callbacks.onConnectError(error);},
      onReconnectPaused:()=>{ready=false;if(!stopped)callbacks.onConnectError(fixedError("gateway_sdk_connect_refused"));}});
     if(stopped){client.stop();return;}client.start();
    }catch(e:any){ready=false;if(!stopped)callbacks.onConnectError(fixedError(e?.code==="ENOENT"?"ENOENT":typeof e?.code==="string"&&/^gateway_sdk_[a-z_]+$/.test(e.code)?e.code:"gateway_sdk_init_refused"));}
   })();
  },
  stop(){
   stopped=true;ready=false;
   if(!client)return;
   try{
    if(typeof client.stopAndWait==="function"){
     void Promise.resolve(client.stopAndWait({timeoutMs:1000})).catch(()=>{try{client.stop();}catch{}});
    }else client.stop();
   }catch{try{client.stop();}catch{}}
  },
  request(method:string,params:any,options:{expectFinal?:boolean;timeoutMs:number;signal?:AbortSignal}){
   if(stopped||!ready||!client)return Promise.reject(fixedError("gateway_sdk_not_ready"));
   // The official SDK retains structured request errors; caller transport owns safe error projection/no-replay.
   return client.request(method,params,options);
  }
 };
}

/** Private QA document staging. No Gateway/config/auth is initialized by this owner path. */
export const QA_DOCUMENT_MAX_BYTES=20*1024*1024;
const qaDocumentTypes:Record<string,string>={
 "Claw_QA_Rapport.xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
 "Claw_QA_Livrables.zip":"application/zip"
};
export async function loadOfficialMediaStore(binary:string):Promise<any>{
 const root=await officialSdkPackageRoot(binary);
 try{
  const media=await nativeImport(pathToFileURL(createRequire(path.join(root,"package.json")).resolve("openclaw/plugin-sdk/media-store")).href);
  if(typeof media.saveMediaBuffer!=="function"||typeof media.resolveMediaBufferPath!=="function")throw Error();
  return media;
 }catch{throw fixedError("qa_document_sdk_unavailable");}
}
function validQaDocumentMeta(meta:any,cleanup=false){
 return plain(meta)&&Object.keys(meta).sort().join(",")===(cleanup?"contentType,filename,id,sha256,size":"contentType,filename,sha256,size")&&
 typeof meta.filename==="string"&&Object.prototype.hasOwnProperty.call(qaDocumentTypes,meta.filename)&&qaDocumentTypes[meta.filename]===meta.contentType&&
 Number.isSafeInteger(meta.size)&&meta.size>=1&&meta.size<=QA_DOCUMENT_MAX_BYTES&&typeof meta.sha256==="string"&&/^[a-f0-9]{64}$/.test(meta.sha256)&&
 (!cleanup||(typeof meta.id==="string"&&meta.id.length<=256&&/^[A-Za-z0-9_.-]+$/.test(meta.id)&&meta.id!=="."&&meta.id!==".."));
}
async function verifiedQaPath(sdk:any,receipt:any){
 const canonical=await sdk.resolveMediaBufferPath(receipt.id,"outbound");
 if(typeof canonical!=="string"||!path.isAbsolute(canonical)||path.basename(canonical)!==receipt.id||/[\0\r\n]/.test(canonical))throw fixedError("qa_document_stage_unverified");
 return canonical;
}
/** Caller holds the existing People SQLite transaction; no new locking/store or lifecycle. */
async function removeQaStagedDocument(sdk:any,receipt:any){
 const canonical=await verifiedQaPath(sdk,receipt);
 const handle=await fs.open(canonical,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);
 try{
  const before=await handle.stat();if(!before.isFile()||before.size!==receipt.size)throw Error();
  const hash=createHash("sha256"),chunk=Buffer.alloc(65536);let offset=0;
  while(offset<before.size){const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,before.size-offset),offset);if(!bytesRead)throw Error();hash.update(chunk.subarray(0,bytesRead));offset+=bytesRead;}
  if(hash.digest("hex")!==receipt.sha256)throw Error();
  const after=await handle.stat(),current=await fs.lstat(canonical);
  if(!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeMs!==before.mtimeMs||current.ctimeMs!==before.ctimeMs||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error();
  await fs.unlink(canonical);
 }finally{await handle.close();}
}
async function enforceQaOutboundCap(sdk:any,receipt:any){
 const canonical=await verifiedQaPath(sdk,receipt);let count=0,bytes=0;
 const directory=await fs.opendir(path.dirname(canonical));
 for await(const entry of directory){
  count++;if(count>500)throw fixedError("qa_document_capacity_refused");
  const stat=await fs.lstat(path.join(path.dirname(canonical),entry.name));
  if(!stat.isFile()||stat.isSymbolicLink())throw fixedError("qa_document_capacity_refused");
  bytes+=stat.size;if(bytes>200*1024*1024)throw fixedError("qa_document_capacity_refused");
 }
}
export async function cleanupQaDocument(input:Readable,binary:string=process.env.CLAWMOBILE_OPENCLAW_BIN||"openclaw",loader=loadOfficialMediaStore){
 let bytes=Buffer.alloc(0);const deadline=setTimeout(()=>input.destroy(fixedError("qa_document_input_timeout")),10000);
 try{for await(const value of input){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);if(bytes.length+chunk.length>2049)throw fixedError("qa_document_header_refused");bytes=Buffer.concat([bytes,chunk]);}}finally{clearTimeout(deadline);}
 if(bytes.length>2048&&bytes[bytes.length-1]!==10)throw fixedError("qa_document_header_refused");
 let meta:any;try{meta=JSON.parse(bytes.toString("utf8"));}catch{throw fixedError("qa_document_header_refused");}
 if(!validQaDocumentMeta(meta,true))throw fixedError("qa_document_header_refused");
 try{await removeQaStagedDocument(await loader(binary),meta);}catch{throw fixedError("qa_document_cleanup_unverified");}
 return {state:"REMOVED",id:meta.id,sha256:meta.sha256};
}
/** One JSON line (at most 2048 bytes, excluding LF), then exact raw bytes; never base64/argv. */
export async function stageQaDocument(input:Readable,binary:string=process.env.CLAWMOBILE_OPENCLAW_BIN||"openclaw",loader=loadOfficialMediaStore){
 let header=Buffer.alloc(0),meta:any=null,size=0;const chunks:Buffer[]=[];
 const deadline=setTimeout(()=>input.destroy(fixedError("qa_document_input_timeout")),10000);
 try{
  for await(const value of input){
   let chunk=Buffer.isBuffer(value)?value:Buffer.from(value);
   if(!meta){
    const newline=chunk.indexOf(10);
    if(newline<0){if(header.length+chunk.length>2048)throw fixedError("qa_document_header_refused");header=Buffer.concat([header,chunk]);continue;}
    if(header.length+newline>2048)throw fixedError("qa_document_header_refused");
    header=Buffer.concat([header,chunk.subarray(0,newline)]);
    try{meta=JSON.parse(header.toString("utf8"));}catch{throw fixedError("qa_document_header_refused");}
    if(!validQaDocumentMeta(meta))throw fixedError("qa_document_header_refused");
    chunk=chunk.subarray(newline+1);
   }
   size+=chunk.length;if(size>meta.size||size>QA_DOCUMENT_MAX_BYTES)throw fixedError("qa_document_size_refused");
   if(chunk.length)chunks.push(chunk);
  }
  if(!meta||size!==meta.size)throw fixedError("qa_document_size_refused");
 }finally{clearTimeout(deadline);}
 const buffer=Buffer.concat(chunks,size);
 if(createHash("sha256").update(buffer).digest("hex")!==meta.sha256)throw fixedError("qa_document_hash_refused");
 const sdk=await loader(binary);
 let saved:any,canonical:any;
 try{
  saved=await sdk.saveMediaBuffer(buffer,meta.contentType,"outbound",QA_DOCUMENT_MAX_BYTES,meta.filename);
  if(!plain(saved)||typeof saved.id!=="string"||saved.id.length>256||!saved.id||/[\\/\0\r\n]/.test(saved.id)||saved.id===".."||typeof saved.path!=="string"||!path.isAbsolute(saved.path)||saved.size!==size||saved.contentType!==meta.contentType)throw Error();
  canonical=await sdk.resolveMediaBufferPath(saved.id,"outbound");
  if(typeof canonical!=="string"||canonical!==saved.path||path.basename(canonical)!==saved.id)throw Error();
 }catch{throw fixedError("qa_document_stage_unverified");}
 const receipt={state:"STAGED",id:saved.id,path:canonical,size,sha256:meta.sha256,contentType:meta.contentType};
 try{await enforceQaOutboundCap(sdk,receipt);}catch{
  try{await removeQaStagedDocument(sdk,receipt);}catch{throw fixedError("qa_document_cleanup_unverified");}
  throw fixedError("qa_document_capacity_refused");
 }
 // Private receipt only. Existing People SQLite serialization is required around materialization.
 return receipt;
}
if(require.main===module){
 if(process.argv.length!==3||!["--qa-stage-document-stdin","--qa-cleanup-document-stdin"].includes(process.argv[2])){
  process.stdout.write(JSON.stringify({state:"REFUSED",code:"qa_document_command_refused"})+"\n");process.exitCode=1;
 }else void (process.argv[2]==="--qa-stage-document-stdin"?stageQaDocument(process.stdin):cleanupQaDocument(process.stdin)).then(result=>process.stdout.write(JSON.stringify(result)+"\n")).catch(error=>{
  const code=typeof error?.code==="string"&&/^(qa_document_[a-z_]+|gateway_sdk_[a-z_]+|ENOENT)$/.test(error.code)?error.code:"qa_document_stage_unverified";
  process.stdout.write(JSON.stringify({state:"REFUSED",code})+"\n");process.exitCode=1;
 });
}
