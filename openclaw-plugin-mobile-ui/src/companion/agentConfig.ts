import crypto from "crypto";
import {readModelOwnerFresh,configuredModelAllow} from "./modelOwner";
import {confirmations} from "./confirmations";
import {callOpenClawGateway} from "./openclawAgentClient";
import {readPaymentRequests,readOwnerConfirmations} from "./runs";
import {findSubmittedRunByClientRunId,reserveSubmittedRun,settleSubmittedRun} from "./runs";
import {accountView,knownProfiles,publicModelRef,resolveModelRef} from "./accountIdentity";
import {invalidateSessionDefaults,observeSessionDefaults,peekSessionDefaults} from "./conversationOwnerIndex";
const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
export const thinkingLevels=["off","minimal","low","medium","high","xhigh","adaptive","max","ultra"];
const identifier=/^[A-Za-z0-9._:/+@-]{1,200}$/;
// The Gateway hash is opaque: 64-hex in fixtures, `hmac-sha256:<b64>` on OpenClaw 2026.9.6 (S24).
const configHash=/^[A-Za-z0-9:+\/=_.-]{16,200}$/;
function configObject(value:any){if(!value?.config||typeof value.config!=="object"||Array.isArray(value.config)||!configHash.test(value.hash||""))throw nativeError("agent_config_unavailable",503);return value.config;}
function selection(config:any){
 const entry=config.agents?.entries?.main;
 const legacy=Array.isArray(config.agents?.list)?config.agents.list.find((row:any)=>row.id==='main'):undefined;
 return {value:entry||legacy||config.agents?.defaults||{},entry:!!entry,writeAvailable:!!entry};
}
function modelId(config:any){const value=selection(config).value.model??config.agents?.defaults?.model;const id=typeof value==='string'?value:value?.primary;return typeof id==='string'&&identifier.test(id)?id:null;}
function level(config:any){const value=selection(config).value.thinkingDefault??config.agents?.defaults?.thinkingDefault;return thinkingLevels.includes(value)?value:null;}
/**
 * One thinking catalog for R6 and R18: the model's own levels when models.list
 * gives them, else the Gateway session defaults for that model (sessions.list
 * `defaults`, the source R18 reads per session). `off` alone only when neither
 * owner says anything.
 */
function thinkingFor(row:any,defaults:any){
 const own=Array.isArray(row?.thinkingLevels)?row.thinkingLevels.map((x:any)=>x?.id).filter((x:any)=>thinkingLevels.includes(x)):[];
 if(own.length)return {levels:own,default:thinkingLevels.includes(row?.thinkingDefault)?row.thinkingDefault:null,source:'model_catalog'};
 const same=defaults&&defaults.modelProvider===row?.provider&&(defaults.model===row?.id||row?.id===defaults.modelProvider+'/'+defaults.model);
 const session=same?(Array.isArray(defaults.thinkingOptions)?defaults.thinkingOptions:Array.isArray(defaults.thinkingLevels)?defaults.thinkingLevels.map((x:any)=>x?.id):[]).filter((x:any)=>thinkingLevels.includes(x)):[];
 if(session.length)return {levels:[...new Set<string>(session)],default:thinkingLevels.includes(defaults.thinkingDefault)?defaults.thinkingDefault:null,source:'session_defaults'};
 return {levels:['off'],default:null,source:'unavailable'};
}
function modelList(value:any,config:any,auth:any,defaults:any=null){
 if(!Array.isArray(value?.models)||value.models.length>2000)throw nativeError('agent_models_unavailable',503);
 const allow=configuredModelAllow(config);
 if(!Array.isArray(allow))return [];
 return value.models.flatMap((row:any)=>{
  const ref=row?.id?.startsWith(row?.provider+'/')?row.id:row?.provider+'/'+row?.id;
  const plugin=config.plugins?.entries?.[row?.provider];
  const thinking=thinkingFor(row,defaults);
  return identifier.test(row?.id||'')&&identifier.test(row?.provider||'')&&allow.includes(ref.split('@')[0])&&plugin?.enabled!==false&&row?.available===true&&validProvider(auth,row.provider)?[{id:row.id,provider:row.provider,reasoning:row.reasoning===true||thinking.source==='session_defaults'&&thinking.levels.some((x:string)=>x!=='off'),thinkingLevels:thinking.levels,thinkingDefault:thinking.default,thinkingSource:thinking.source}]:[];
 });
}
/**
 * sessions.list `defaults`, the R18 composer source. The conversation owner index already reads sessions.list
 * (every page carries `defaults`): a projection younger than [DEFAULTS_SERVE_MS] is reused without I/O. Otherwise one
 * bounded read with the owner budget (10 s, like readModelOwnerFresh): on the S24 the former 5.5 s budget expired
 * while four other CLI reads ran in parallel. A failed read keeps the last observed defaults up to [DEFAULTS_KEEP_MS].
 */
const DEFAULTS_SERVE_MS=300000,DEFAULTS_KEEP_MS=1800000;
let sessionDefaultsFlight:Promise<any>|null=null;
async function sessionDefaults(){
 const cached=peekSessionDefaults(DEFAULTS_SERVE_MS);if(cached)return cached;
 if(sessionDefaultsFlight)return sessionDefaultsFlight;
 const read=(async()=>{
  try{const value=await callOpenClawGateway('sessions.list',{limit:1},{timeoutMs:10000,hardTimeoutMs:10000});observeSessionDefaults(value?.defaults);}catch{/* last observed defaults below */}
  return peekSessionDefaults(DEFAULTS_KEEP_MS);
 })();
 sessionDefaultsFlight=read;
 try{return await read;}finally{if(sessionDefaultsFlight===read)sessionDefaultsFlight=null;}
}
/** `sessions.usage` only feeds the informative usage line: bounded like the other owner reads and kept 60 s. */
const SESSIONS_USAGE_MS=60000;
let sessionsUsage:{value:any,at:number}|null=null;
let sessionsUsageFlight:Promise<any>|null=null;
async function readSessionsUsage(){
 if(sessionsUsage&&Date.now()-sessionsUsage.at<SESSIONS_USAGE_MS)return sessionsUsage.value;
 if(sessionsUsageFlight)return sessionsUsageFlight;
 const read=(async()=>{
  try{const value=await callOpenClawGateway('sessions.usage',{limit:100},{timeoutMs:5500,hardTimeoutMs:5500});sessionsUsage={value:value?.totals&&typeof value.totals==='object'?{totals:{...value.totals}}:null,at:Date.now()};return sessionsUsage.value;}
  catch{return null;}
 })();
 sessionsUsageFlight=read;
 try{return await read;}finally{if(sessionsUsageFlight===read)sessionsUsageFlight=null;}
}
function validProvider(auth:any,provider:string,profile?:string){
 if(auth?.unavailable||!Array.isArray(auth?.providers))return false;
 const row=auth.providers.find((x:any)=>x.provider===provider);
 return !!row&&['ok','static','expiring'].includes(row.status)&&(!profile||row.profiles?.some((x:any)=>x.profileId===profile&&['ok','static','expiring'].includes(x.status)));
}
const count=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export async function readAgentConfig(){
 const [{raw,catalog,auth},usage,defaults]=await Promise.all([readModelOwnerFresh(),readSessionsUsage(),sessionDefaults()]);
 const config=configObject(raw),id=modelId(config);
 const chosen=selection(config).value;
 const model=chosen.model??config.agents?.defaults?.model;
 const fallbackValue=typeof model==='object'?model?.fallbacks??config.agents?.defaults?.model?.fallbacks:config.agents?.defaults?.model?.fallbacks;
 const fallbacks=Array.isArray(fallbackValue)&&fallbackValue.length<=20?fallbackValue.filter((row:any)=>typeof row==='string'&&identifier.test(row)):null;
 const toolPolicy=(value:any)=>({profile:['minimal','coding','messaging','full'].includes(value?.profile)?value.profile:null,allow:Array.isArray(value?.allow)&&value.allow.length<=100?value.allow.filter((x:any)=>typeof x==='string'&&/^[A-Za-z0-9_.*:-]{1,100}$/.test(x)):null,deny:Array.isArray(value?.deny)&&value.deny.length<=100?value.deny.filter((x:any)=>typeof x==='string'&&/^[A-Za-z0-9_.*:-]{1,100}$/.test(x)):null});
 const models=modelList(catalog,config,auth,defaults);
 // Account profiles leave only as opaque `acct-…` handles with a neutral label (never the e-mail).
 const accounts=[...new Map([id,...(fallbacks||[])].map(ref=>accountView(ref)).filter(Boolean).map((row:any)=>[row.id,row])).values()];
 return {success:true,state:'ok',receipt:null,schemaVersion:1,revision:raw.hash,agentId:'main',model:publicModelRef(id),provider:id?.includes('/')?id.split('/')[0]:null,
  fallbacks:fallbacks?fallbacks.map(ref=>publicModelRef(ref)!):null,accounts,tools:{global:toolPolicy(config.tools),agent:toolPolicy(chosen.tools),effective:null,reason:'effective_tool_catalog_unavailable'},
  thinking:level(config),thinkingLevels,models,writeAvailable:selection(config).writeAvailable&&models.length>0,issues:[...(models.length?[]:['model_authentication_proof_unavailable']),...(defaults?[]:['session_thinking_defaults_unavailable'])],
  usage:usage?{scope:'sessions_usage_limit_100',inputTokens:count(usage.totals?.inputTokens),outputTokens:count(usage.totals?.outputTokens),totalTokens:count(usage.totals?.totalTokens),costUsd:count(usage.totals?.totalCost)}:null};
}
async function protectedActivity(){
 const [payments,confirmations]=await Promise.all([readPaymentRequests(),readOwnerConfirmations()]);
 return payments.some(row=>['awaiting_owner','executing','effect_unknown','requires_bank_action'].includes(row.state))||confirmations.some(row=>row.state==='awaiting_owner'&&row.expiresAt>Date.now());
}
function stored(status:any){
 if(status?.state==='done'&&typeof status.result==='string')try{const value=JSON.parse(status.result);if(value.receipt?.runId===status.runId&&value.receipt.version===1)return value;}catch{}
 return {success:false,state:'indeterminate',receipt:null};
}
const pending=new Map<string,Promise<any>>();
export async function changeAgentConfig(body:any){
 const key=typeof body?.operationId==='string'?body.operationId:'';
 if(pending.has(key)){await pending.get(key);return changeAgentConfig(body);}
 const work=changeAgentConfigOnce(body);pending.set(key,work);
 try{return await work;}finally{if(pending.get(key)===work)pending.delete(key);}
}
async function changeAgentConfigOnce(body:any){
 const required=['model','operationId','provider','revision','thinking'];
 if(!body||typeof body!=='object'||Array.isArray(body)||required.some(key=>!(key in body))||Object.keys(body).some(key=>![...required,'fallbacks','confirmationId'].includes(key))||
  !/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId||'')||!identifier.test(body.provider||'')||!identifier.test(body.model||'')||
  !configHash.test(body.revision||'')||!thinkingLevels.includes(body.thinking)||
  ('fallbacks' in body&&(!Array.isArray(body.fallbacks)||body.fallbacks.length>20||new Set(body.fallbacks).size!==body.fallbacks.length||body.fallbacks.some((ref:any)=>typeof ref!=='string'||!identifier.test(ref)||!ref.includes('/')))))throw nativeError('invalid_agent_config');
 const desired={provider:body.provider,model:body.model,thinking:body.thinking,revision:body.revision,...('fallbacks' in body?{fallbacks:body.fallbacks}:{})};
 const target='main:'+crypto.createHash('sha256').update(JSON.stringify(desired)).digest('hex');
 const identity=JSON.stringify({action:'agent.config',target}),clientId='agent-operation-'+crypto.createHash('sha256').update(body.operationId).digest('hex'),sessionId='native-owner-actions';
 const existing=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 if(existing&&stored(existing).state!=='failed')return stored(existing);
 if(await protectedActivity())throw nativeError('protected_owner_activity',409);
 // Validate against the canonical current config/catalog before reserving an effect.
 const [{raw,catalog,auth},defaults]=await Promise.all([readModelOwnerFresh(),sessionDefaults()]);const config=configObject(raw);
 if(raw.hash!==body.revision)throw nativeError('agent_config_revision_changed',409);
 if(!selection(config).writeAvailable)throw nativeError('agent_config_owner_shape_unsupported',409);
 // The app echoes `@acct-…` handles; the patch and every comparison use the canonical profile ids.
 const currentFallbacks=selection(config).value.model?.fallbacks||[];
 let fallbacks:string[]|undefined;
 if('fallbacks' in body){
  const profiles=knownProfiles(auth,currentFallbacks,modelId(config));
  const resolved=body.fallbacks.map((ref:string)=>resolveModelRef(ref,profiles));
  if(resolved.some((ref:string|null)=>ref===null))throw nativeError('unsupported_agent_fallback',409);
  fallbacks=resolved as string[];
 }
 const models=modelList(catalog,config,auth,defaults),found=models.find((row:any)=>row.id===body.model&&row.provider===body.provider);
 if(!found||!found.thinkingLevels.includes(body.thinking))throw nativeError('unsupported_agent_model',409);
 const refs=models.map((row:any)=>row.id.startsWith(row.provider+'/')?row.id:row.provider+'/'+row.id);
 if(fallbacks?.some((ref:string)=>!currentFallbacks.includes(ref)&&(!refs.includes(ref.split('@')[0])||ref.includes('@')&&!validProvider(auth,ref.split('/')[0],ref.split('@')[1]))))throw nativeError('unsupported_agent_fallback',409);
 if(await protectedActivity())throw nativeError('protected_owner_activity',409);
 const id=body.model.startsWith(body.provider+'/')?body.model:body.provider+'/'+body.model;
 const values={model:{primary:id,...(fallbacks?{fallbacks}:{})},thinkingDefault:body.thinking};
 const patch={agents:{entries:{main:values}}};
 const oldFallbacks=selection(config).value.model?.fallbacks||[];
 const expanded=fallbacks?.some((ref:string)=>!oldFallbacks.includes(ref)&&ref.split('/')[0]!==id.split('/')[0]||ref.includes('@')&&!oldFallbacks.includes(ref));
 if(expanded){
  if(typeof body.confirmationId!=='string')throw nativeError('fallback_confirmation_required',409);
  const record=await confirmations.status(body.confirmationId);
  await confirmations.consume(body.confirmationId,{audience:'confirmation',action:{type:'agent.config.expand_fallbacks',reference:'main',payloadHash:crypto.createHash('sha256').update(JSON.stringify(desired)).digest('hex')},presentation:record.intent.presentation,origin:record.intent.origin});
 }
 const reserved=await reserveSubmittedRun(identity,sessionId,clientId,{requestText:identity,executionSource:'capability_first',decision:{version:2,type:'EXECUTE',capability:'agent.config'}});
 if(!reserved.created&&stored(reserved.status).state!=='failed')return stored(reserved.status);
 let state='indeterminate',artifact:any;
 try{
  // Check the canonical protected link again immediately before dispatch.
  if(await protectedActivity())state='refused';
  else{
   let verified:any,patchError:any;
   try{await callOpenClawGateway('config.patch',{baseHash:body.revision,raw:JSON.stringify(patch),...('fallbacks' in body?{replacePaths:['agents.entries.main.model.fallbacks']}:{})});}
   catch(error:any){patchError=error;}
   const code=String(patchError?.code||'');const text=String(patchError?.message||'');
   if(patchError&&(['ECONNREFUSED','ENOENT'].includes(code)||/\bECONNREFUSED\b/.test(text))){state='failed';artifact={reason:'gateway_unreachable',effectNotStarted:true};}
   else if(patchError&&/baseHash|hash mismatch|config.*changed|revision.*conflict/i.test(text)){state='refused';artifact={reason:'agent_config_revision_changed'};}
   else{
    for(let attempt=0;attempt<3;attempt++){try{verified=await callOpenClawGateway('config.get',{}, {hardTimeoutMs:2000});break;}catch{if(attempt<2)await new Promise(resolve=>setTimeout(resolve,200));}}

   const effective=configObject(verified),effectiveModel=selection(effective).value.model??effective.agents?.defaults?.model;
   if(modelId(effective)===id&&level(effective)===body.thinking&&(!fallbacks||JSON.stringify(effectiveModel?.fallbacks)===JSON.stringify(fallbacks))){state='completed';invalidateSessionDefaults();artifact={configurationRevision:verified.hash,agentId:'main'};}
   }
  }
 }catch{/* No proof: never repeat a possible configuration effect. */}
 const result={success:state==='completed',state,...(artifact?{artifact}:{}),receipt:{version:1,action:'agent.config',target,operationId:body.operationId,runId:reserved.status.runId,state,at:reserved.status.submittedAt}};
 await settleSubmittedRun(reserved.status.runId,'done',JSON.stringify(result));
 const saved=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 return saved?stored(saved):{success:false,state:'indeterminate',receipt:null};
}
