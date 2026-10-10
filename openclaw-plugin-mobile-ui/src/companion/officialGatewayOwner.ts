/** Official SDK owner adapter; credential/config readers and protocol remain OpenClaw-owned. */
import fs from "fs/promises";
import path from "path";
import {pathToFileURL} from "url";
import {createRequire} from "module";
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
export async function loadOfficialGatewaySdk(binary:string):Promise<any>{
 let entry:string;
 try{entry=require.resolve("openclaw/plugin-sdk/gateway-runtime");}
 catch{
  let root:string;try{root=await ownerPackageRoot(await selectedBinaryPath(binary));}catch(e:any){if(e?.code==="ENOENT")throw fixedError("ENOENT");throw fixedError("gateway_sdk_unavailable");}
  try{entry=createRequire(path.join(root,"package.json")).resolve("openclaw/plugin-sdk/gateway-runtime");}catch{throw fixedError("ENOENT");}
 }
 const root=await ownerPackageRoot(entry);
 let metadata:any;try{metadata=JSON.parse(await fs.readFile(path.join(root,"package.json"),"utf8"));}catch{throw fixedError("gateway_sdk_unavailable");}
 if(metadata.version!=="2026.9.6")throw fixedError("gateway_sdk_version_unsupported");
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
