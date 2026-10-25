import crypto from "crypto";
import {readModelOwnerFresh,configuredModelAllow,modelReferenceAllowed,configuredModelFlow,includedModelAccounts,CONTACT_MODEL_AGENTS,observeVerifiedModelOwnerConfig} from "./modelOwner";
import {confirmations} from "./confirmations";
import {callOpenClawGateway} from "./openclawAgentClient";
import {readPaymentRequests,readOwnerConfirmations,getRunStatus,latestModelFlowConfiguration,checkpointModelFlowConfiguration} from "./runs";
import {memoryRemember} from "./memoryControl";
import {preserveModelFlowSessions} from "./conversationMetadata";
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
  return identifier.test(row?.id||'')&&identifier.test(row?.provider||'')&&modelReferenceAllowed(allow,ref)&&plugin?.enabled!==false&&row?.available===true&&validProvider(auth,row.provider)?[{id:row.id,provider:row.provider,reasoning:row.reasoning===true||thinking.source==='session_defaults'&&thinking.levels.some((x:string)=>x!=='off'),thinkingLevels:thinking.levels,thinkingDefault:thinking.default,thinkingSource:thinking.source}]:[];
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
// The complete public projection is immutable for a short window. This is the HTTP read cache for
// /agent/config: simultaneous requests share the whole computation, rather than only two of its five
// Gateway calls. Configuration mutations bypass it and invalidate it once the Gateway proves the effect.
const AGENT_CONFIG_SERVE_MS=5000;
let agentConfigCache:{value:any,at:number}|null=null;
let agentConfigFlight:Promise<any>|null=null;
function invalidateAgentConfigCache(){agentConfigCache=null;}
async function buildAgentConfig(){
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
export async function readAgentConfig(flow?:EditableModelFlow){
 if(flow)return readModelFlowConfig(flow);
 if(agentConfigCache&&Date.now()-agentConfigCache.at<AGENT_CONFIG_SERVE_MS)return agentConfigCache.value;
 if(agentConfigFlight)return agentConfigFlight;
 const read=buildAgentConfig();agentConfigFlight=read;
 try{const value=await read;if(value.usage&&!(value.issues||[]).includes('session_thinking_defaults_unavailable'))agentConfigCache={value,at:Date.now()};return value;}
 finally{if(agentConfigFlight===read)agentConfigFlight=null;}
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
 const work=body?.flow!==undefined?changeModelFlowConfigOnce(body):changeAgentConfigOnce(body);pending.set(key,work);
 try{return await work;}finally{if(pending.get(key)===work)pending.delete(key);}
}
async function changeAgentConfigOnce(body:any){
 if(flowEnabled())throw nativeError('model_flow_required',409);
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
  const confirmation={scope:'agent.config.expand_fallbacks',reference:'main',payloadHash:crypto.createHash('sha256').update(JSON.stringify(desired)).digest('hex')};
  if(typeof body.confirmationId!=='string')throw Object.assign(nativeError('confirmation_required',403),{confirmation});
  const record=await confirmations.status(body.confirmationId);
  await confirmations.consume(body.confirmationId,{audience:'confirmation',action:{type:confirmation.scope,reference:confirmation.reference,payloadHash:confirmation.payloadHash},presentation:record.intent.presentation,origin:record.intent.origin});
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
   if(modelId(effective)===id&&level(effective)===body.thinking&&(!fallbacks||JSON.stringify(effectiveModel?.fallbacks)===JSON.stringify(fallbacks))){state='completed';invalidateSessionDefaults();invalidateAgentConfigCache();artifact={configurationRevision:verified.hash,agentId:'main'};}
   }
  }
 }catch{/* No proof: never repeat a possible configuration effect. */}
 const result={success:state==='completed',state,...(artifact?{artifact}:{}),receipt:{version:1,action:'agent.config',target,operationId:body.operationId,runId:reserved.status.runId,state,at:reserved.status.submittedAt}};
 await settleSubmittedRun(reserved.status.runId,'done',JSON.stringify(result));
 const saved=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 return saved?stored(saved):{success:false,state:'indeterminate',receipt:null};
}


export type EditableModelFlow='brain'|'conversation_summary'|'whatsapp';
const modelFlowIds=new Set<EditableModelFlow>(['brain','conversation_summary','whatsapp']);
const flowEnabled=()=>process.env.SAMANTHA_BRAIN_ONLY==='1';
function modelFlow(value:any):EditableModelFlow{if(!modelFlowIds.has(value))throw nativeError('invalid_model_flow');return value;}
function flowAgents(flow:EditableModelFlow):string[]{return flow==='whatsapp'?['main',...CONTACT_MODEL_AGENTS]:['main'];}
function selectedFlowModels(owner:any,flow:EditableModelFlow,defaults:any){
 const config=configObject(owner.raw),rows=owner.catalog?.models;
 if(!Array.isArray(rows)||rows.length>2000)throw nativeError('agent_models_unavailable',503);
 const choices=rows.flatMap((row:any)=>{
  if(!identifier.test(row?.id||'')||!identifier.test(row?.provider||'')||row.available!==true||config.plugins?.entries?.[row.provider]?.enabled===false)return [];
  const base=row.id.startsWith(row.provider+'/')?row.id:row.provider+'/'+row.id;
  if(!flowAgents(flow).every(id=>modelReferenceAllowed(configuredModelAllow(config,id),base)))return [];
  const thinking=thinkingFor(row,defaults);
  return includedModelAccounts(base,owner.auth,owner.policy).map(account=>({id:row.id,provider:row.provider,ref:publicModelRef(account.reference),account:account.account,
   accountLabel:row.provider+' · compte connecté',costPolicy:account.costPolicy,costProofSource:account.source,reasoning:row.reasoning===true,
   thinkingLevels:thinking.levels,thinkingDefault:thinking.default,thinkingSource:thinking.source,fastModeSupported:base==='openai/gpt-5.6-sol'}));
 });
 if(choices.length>256||new Set(choices.map(row=>row.ref)).size!==choices.length)throw nativeError('agent_models_unavailable',503);
 return choices;
}
function flowPaths(flow:EditableModelFlow):string[][]{
 if(flow==='conversation_summary')return [['agents','defaults','compaction','model']];
 const agents=flow==='brain'?['main']:[...CONTACT_MODEL_AGENTS];
 return [...agents.flatMap(id=>['model','thinkingDefault','fastModeDefault'].map(field=>['agents','entries',id,field])),
  ...(flow==='whatsapp'?[['plugins','entries','openclaw-plugin-mobile-ui','config','whatsappModelFlow']]:[])];
}
function objectAt(value:any,segments:string[]){let node=value;for(const key of segments){if(!node||typeof node!=='object'||Array.isArray(node)||!Object.prototype.hasOwnProperty.call(node,key))return {present:false};node=node[key];}return {present:true,value:node};}
function publicFlowValue(value:any,depth=0):any{
 if(depth>12)throw nativeError('model_flow_snapshot_unsupported',409);
 if(typeof value==='string'){if(!identifier.test(value))throw nativeError('model_flow_snapshot_unsupported',409);return value.includes('/')?publicModelRef(value):value;}
 if(typeof value==='boolean')return value;
 if(Array.isArray(value)&&value.length<=20)return value.map(row=>publicFlowValue(row,depth+1));
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>['version','model','primary','fallbacks','thinkingDefault','fastModeDefault'].includes(key))){
  return Object.fromEntries(['version','model','primary','fallbacks','thinkingDefault','fastModeDefault'].filter(key=>key in value).map(key=>[key,key==='version'&&value[key]===1?1:publicFlowValue(value[key],depth+1)]));
 }
 throw nativeError('model_flow_snapshot_unsupported',409);
}
function flowContainers(flow:EditableModelFlow):string[][]{return flow==='conversation_summary'?[['agents','defaults','compaction']]:flow==='whatsapp'?[['plugins','entries','openclaw-plugin-mobile-ui','config']]:[];}
function flowSnapshot(config:any,flow:EditableModelFlow){return [...flowPaths(flow).map(path=>{const value=objectAt(config,path);return {path,present:value.present,...(value.present?{value:publicFlowValue((value as any).value)}:{})};}),...flowContainers(flow).map(path=>({path,present:objectAt(config,path).present,container:true}))];}
function flowHash(value:any){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function flowResult(status:any){
 if(status?.state==='done'&&typeof status.result==='string'&&status.result.length<=65536)try{const result=JSON.parse(status.result);if(result?.receipt?.version===2&&result.receipt.action==='agent.config'&&result.receipt.runId===status.runId)return result;}catch{}
 return {success:false,state:'indeterminate',receipt:null};
}
async function readModelFlowConfig(flow:EditableModelFlow){
 const [owner,defaults,latest]=await Promise.all([readModelOwnerFresh(),sessionDefaults(),latestModelFlowConfiguration(flow)]);
 const config=configObject(owner.raw),current=configuredModelFlow(config,flow),model=current.model,primary=typeof model==='string'?model:model?.primary;
 const fallbacks=model&&typeof model==='object'&&Array.isArray(model.fallbacks)?model.fallbacks:[];
 const choices=selectedFlowModels(owner,flow,defaults),snapshot=flowSnapshot(config,flow),revert=latest?.receipt?.appliedHash===flowHash(snapshot)?latest.receipt.runId:null;
 return {success:true,state:'ok',receipt:null,schemaVersion:2,flow,revision:owner.raw.hash,model:publicModelRef(primary),fallbacks:fallbacks.map((ref:string)=>publicModelRef(ref)),thinking:current.thinkingDefault??null,
  fastMode:typeof current.fastModeDefault==='boolean'?current.fastModeDefault:null,inheritsFrom:current.inheritsFrom,origins:current.origins,mixedFields:current.mixedFields,source:'gateway_config',models:choices,
  writeFields:flow==='conversation_summary'?['model']:['model','thinking','fallbacks','fastMode'],writeAvailable:flowEnabled()&&choices.length>0,
  previousReceiptRunId:revert,issues:[...(!flowEnabled()?['brain_only_not_active']:[]),...(!choices.length?['included_model_authentication_proof_unavailable']:[])],
  appliesTo:'new_sessions',metrics:{windowDays:7,notThisRate:null,latencyMedianMs:null,state:'unavailable'}};
}

function setFlowPath(config:any,path:string[],value:any,present=true){
 let node=config;for(const part of path.slice(0,-1)){if(!node[part]||typeof node[part]!=='object'||Array.isArray(node[part])){if(!present)return;node[part]={};}node=node[part];}
 if(present)node[path.at(-1)!]=value;else delete node[path.at(-1)!];
}
function flowPatchRows(flow:EditableModelFlow,snapshot:any){
 const expected=[...flowPaths(flow).map(path=>({path,container:false})),...flowContainers(flow).map(path=>({path,container:true}))];
 const invalid=!Array.isArray(snapshot)||snapshot.length!==expected.length||snapshot.some((row:any,index:number)=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||JSON.stringify(row.path)!==JSON.stringify(expected[index].path)||typeof row.present!=='boolean'||Object.keys(row).some(key=>!['path','present','value','container'].includes(key)))return true;
  if(expected[index].container)return row.container!==true||'value' in row;
  return row.container!==undefined||row.present!==('value' in row);
 });
 if(invalid)throw nativeError('model_flow_receipt_invalid',409);
 return snapshot;
}

function canonicalFlowReference(value:string,owner:any,models:any[],exactPrevious=false):string{
 if(!identifier.test(value)||!value.includes('/'))throw nativeError('model_flow_model_not_included',409);
 const profiles=knownProfiles(owner.auth),resolved=resolveModelRef(value,profiles);
 if(!resolved)throw nativeError('model_flow_account_unavailable',409);
 const same=models.filter(choice=>choice.ref===publicModelRef(resolved));
 if(same.length===1)return resolved;
 if(!resolved.includes('@')){
  const candidates=models.filter(choice=>choice.ref?.split('@')[0]===resolved);
  const provider=owner.auth?.providers?.find((row:any)=>row.provider===resolved.split('/')[0]);
  const healthy=(provider?.profiles||[]).filter((row:any)=>['ok','static','expiring'].includes(row.status));
  if(candidates.length===1&&(!exactPrevious||healthy.length===1)){
   if(exactPrevious)return resolved; // Exact prior key presence/value, only with an unambiguous included account.
   const canonical=resolveModelRef(candidates[0].ref,profiles);if(canonical)return canonical;
  }
 }
 throw nativeError('model_flow_model_not_included',409);
}
function restoreFlowValue(value:any,owner:any,models:any[]):any{
 if(typeof value==='string')return value.includes('/')?canonicalFlowReference(value,owner,models,true):value;
 if(typeof value==='boolean'||value===1)return value;
 if(Array.isArray(value))return value.map(row=>restoreFlowValue(row,owner,models));
 if(value&&typeof value==='object'&&Object.keys(value).every(key=>['version','model','primary','fallbacks','thinkingDefault','fastModeDefault'].includes(key)))return Object.fromEntries(Object.entries(value).map(([key,row])=>[key,restoreFlowValue(row,owner,models)]));
 throw nativeError('model_flow_receipt_invalid',409);
}
function flowRefs(value:any):string[]{const model=value?.model??value;return typeof model==='string'?[model]:model&&typeof model==='object'?[model.primary,...(Array.isArray(model.fallbacks)?model.fallbacks:[])].filter((ref:any)=>typeof ref==='string'):[];}
function flowAccountSet(value:any,owner:any):Set<string>{
 const profiles=knownProfiles(owner.auth),out=new Set<string>();
 for(const ref of flowRefs(value)){
  const resolved=resolveModelRef(ref,profiles);if(!resolved)continue;
  if(resolved.includes('@'))out.add(resolved.split('/')[0]+'@'+resolved.split('@')[1]);
  else {const provider=owner.auth?.providers?.find((row:any)=>row.provider===resolved.split('/')[0]),healthy=(provider?.profiles||[]).filter((row:any)=>['ok','static','expiring'].includes(row.status));if(healthy.length===1)out.add(provider.provider+'@'+healthy[0].profileId);}
 }
 return out;
}
function previousFlowAccounts(config:any,flow:EditableModelFlow,owner:any):Set<string>{
 const sources=flow==='whatsapp'?[configuredModelFlow(config,flow),...CONTACT_MODEL_AGENTS.map(id=>config.agents?.entries?.[id])]:[configuredModelFlow(config,flow)];
 const sets=sources.map(value=>flowAccountSet(value,owner));
 return new Set([...sets[0]].filter(value=>sets.every(set=>set.has(value))));
}
function validateEffectiveFlow(config:any,flow:EditableModelFlow,owner:any,models:any[]){
 const selected=configuredModelFlow(config,flow);
 for(const ref of flowRefs(selected))canonicalFlowReference(ref,owner,models,true);
 if(flow!=='conversation_summary'){
  const primary=flowRefs(selected)[0],choice=models.find(row=>row.ref?.split('@')[0]===primary?.split('@')[0]);
  if(!choice||!choice.thinkingLevels.includes(selected.thinkingDefault)||typeof selected.fastModeDefault!=='boolean'||selected.fastModeDefault&&!choice.fastModeSupported)throw nativeError('model_flow_options_unsupported',409);
 }
}
async function changeModelFlowConfigOnce(body:any){
 const flow=modelFlow(body?.flow);
 if(!flowEnabled())throw nativeError('model_flow_not_active',409);
 const mode=body.mode,common=['flow','mode','revision','operationId','confirmationId'];
 const fields=mode==='set'?(flow==='conversation_summary'?['model']:['model','thinking','fallbacks','fastMode']):mode==='revert'?['restoreRunId']:mode==='inherit'?[]:null;
 if(!fields||typeof body!=='object'||Array.isArray(body)||fields.some(key=>!(key in body))||Object.keys(body).some(key=>![...common,...fields].includes(key))||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId||'')||!configHash.test(body.revision||''))throw nativeError('invalid_model_flow_config');
 if(mode==='set'&&(!identifier.test(body.model||'')||!body.model.includes('/')||flow!=='conversation_summary'&&(!thinkingLevels.includes(body.thinking)||typeof body.fastMode!=='boolean'||!Array.isArray(body.fallbacks)||body.fallbacks.length>20||new Set(body.fallbacks).size!==body.fallbacks.length||body.fallbacks.some((ref:any)=>typeof ref!=='string'||!identifier.test(ref)||!ref.includes('/')))))throw nativeError('invalid_model_flow_config');
 if(mode==='revert'&&(typeof body.restoreRunId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(body.restoreRunId)))throw nativeError('invalid_model_flow_config');
 const desired={flow,mode,revision:body.revision,...Object.fromEntries(fields.map(key=>[key,body[key]]))};
 const payloadHash=flowHash(desired),target=flow+':'+payloadHash,identity=JSON.stringify({action:'agent.config',target});
 const clientId='agent-operation-'+crypto.createHash('sha256').update(body.operationId).digest('hex'),sessionId='native-owner-actions';
 const existing=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 if(existing&&flowResult(existing).state!=='failed')return flowResult(existing);
 if(await protectedActivity())throw nativeError('protected_owner_activity',409);
 const [owner,defaults]=await Promise.all([readModelOwnerFresh(),sessionDefaults()]);const config=configObject(owner.raw);
 if(owner.raw.hash!==body.revision)throw nativeError('agent_config_revision_changed',409);
 if(!config.agents?.entries?.main||flow==='whatsapp'&&(!config.plugins?.entries?.['openclaw-plugin-mobile-ui']||CONTACT_MODEL_AGENTS.some(id=>!config.agents?.entries?.[id])))throw nativeError('model_flow_owner_shape_unsupported',409);
 const models=selectedFlowModels(owner,flow,defaults);if(!models.length)throw nativeError('included_model_policy_unavailable',409);
 const previous=flowSnapshot(config,flow),next=JSON.parse(JSON.stringify(config));
 if(mode==='set'){
  const model=canonicalFlowReference(body.model,owner,models),fallbacks=flow==='conversation_summary'?[]:body.fallbacks.map((ref:string)=>canonicalFlowReference(ref,owner,models));
  const choice=models.find(row=>row.ref===publicModelRef(model));
  if(!choice||flow!=='conversation_summary'&&(!choice.thinkingLevels.includes(body.thinking)||body.fastMode&&!choice.fastModeSupported))throw nativeError('model_flow_options_unsupported',409);
  if(flow==='conversation_summary')setFlowPath(next,['agents','defaults','compaction','model'],model);
  else{
   const selection={model:{primary:model,fallbacks},thinkingDefault:body.thinking,fastModeDefault:body.fastMode};
   for(const id of flow==='brain'?['main']:[...CONTACT_MODEL_AGENTS])for(const field of ['model','thinkingDefault','fastModeDefault'])setFlowPath(next,['agents','entries',id,field],(selection as any)[field]);
   if(flow==='whatsapp')setFlowPath(next,['plugins','entries','openclaw-plugin-mobile-ui','config','whatsappModelFlow'],{version:1,...selection});
  }
 }else if(mode==='inherit'){
  for(const row of flowPaths(flow))setFlowPath(next,row,undefined,false);
 }else{
  const stored=flowResult(await getRunStatus(body.restoreRunId));
  if(stored.state!=='completed'||stored.receipt.flow!==flow||stored.receipt.appliedHash!==flowHash(previous))throw nativeError('model_flow_previous_version_changed',409);
  for(const row of flowPatchRows(flow,stored.receipt.previous)){
   if(row.container){if(!row.present){const current=objectAt(next,row.path);if(current.present&&Object.keys((current as any).value||{}).length)throw nativeError('model_flow_parent_changed',409);setFlowPath(next,row.path,undefined,false);}}
   else setFlowPath(next,row.path,row.present?restoreFlowValue(row.value,owner,models):undefined,row.present);
  }
 }
 validateEffectiveFlow(next,flow,owner,models);
 const applied=flowSnapshot(next,flow);
 if(Buffer.byteLength(JSON.stringify({previous,applied}))>48000)throw nativeError('model_flow_snapshot_too_large',409);
 const priorAccounts=previousFlowAccounts(config,flow,owner),afterAccounts=flowAccountSet(configuredModelFlow(next,flow),owner);
 const expanded=[...afterAccounts].some(account=>!priorAccounts.has(account));
 if(expanded){
  const challenge={scope:'agent.config.expand_fallbacks',reference:'flow:'+flow,payloadHash};
  if(typeof body.confirmationId!=='string')throw Object.assign(nativeError('confirmation_required',403),{confirmation:challenge});
  const record=await confirmations.status(body.confirmationId);
  await confirmations.consume(body.confirmationId,{audience:'confirmation',action:{type:challenge.scope,reference:challenge.reference,payloadHash},presentation:record.intent.presentation,origin:record.intent.origin});
 }
 const reserved=await reserveSubmittedRun(identity,sessionId,clientId,{requestText:identity,executionSource:'capability_first',decision:{version:2,type:'EXECUTE',capability:'agent.config',modelFlow:flow}});
 if(!reserved.created&&flowResult(reserved.status).state!=='failed')return flowResult(reserved.status);
 const preparedReceipt={version:2,action:'agent.config',flow,target,operationId:body.operationId,runId:reserved.status.runId,at:reserved.status.submittedAt,previous,appliedHash:flowHash(applied)};
 await checkpointModelFlowConfiguration(reserved.status.runId,{success:false,state:'prepared',receipt:preparedReceipt});
 let state='indeterminate',artifact:any;
 try{
  if(await protectedActivity())state='refused';
  else{
   const preservation=await preserveModelFlowSessions(flow,config,body.operationId);
   if(preservation?.state!=='verified')throw nativeError('model_flow_new_session_policy_unverified',409);
   const fresh=await callOpenClawGateway('config.get',{}, {hardTimeoutMs:3000});if(fresh?.hash!==body.revision)throw nativeError('agent_config_revision_changed',409);
   const patch:any={};for(const path of flowPaths(flow)){const value=objectAt(next,path);setFlowPath(patch,path,value.present?(value as any).value:null);}for(const path of flowContainers(flow))if(!objectAt(next,path).present)setFlowPath(patch,path,null);
   await checkpointModelFlowConfiguration(reserved.status.runId,{success:false,state:'dispatching',receipt:preparedReceipt,artifact:{preservedSessions:preservation.preserved}});
   let dispatchError:any;try{await callOpenClawGateway('config.patch',{baseHash:body.revision,raw:JSON.stringify(patch),replacePaths:flowPaths(flow).map(row=>row.join('.'))});}catch(error){dispatchError=error;}
   const observed=await callOpenClawGateway('config.get',{}, {hardTimeoutMs:4000});
   if(flowHash(flowSnapshot(configObject(observed),flow))===flowHash(applied)){
    state='completed';invalidateAgentConfigCache();invalidateSessionDefaults();observeVerifiedModelOwnerConfig({...owner,raw:observed});
    let continuity='pending';try{const event=await memoryRemember({surface:'app',kind:'completed_action',text:'Modèles par flux : configuration '+flow+' vérifiée ; reçu '+reserved.status.runId+'. Aucun droit ni contexte de contact modifié.'});if(event.state==='recorded')continuity='recorded';}catch{}
    artifact={configurationRevision:observed.hash,flow,preservedSessions:preservation.preserved,continuity};
   }else if(dispatchError&&/baseHash|hash mismatch|config.*changed|revision.*conflict/i.test(String(dispatchError?.message||''))){state='refused';artifact={reason:'agent_config_revision_changed'};}
   else if(dispatchError&&['ECONNREFUSED','ENOENT'].includes(String(dispatchError?.code||''))){state='failed';artifact={reason:'gateway_unreachable',effectNotStarted:true};}
  }
 }catch(error:any){if(error?.statusCode===409&&/^(agent_config_revision_changed|model_flow_[a-z_]+|conversation_[a-z_]+)$/.test(error?.message||'')){state='refused';artifact={reason:error.message};}}
 const result={success:state==='completed',state,...(artifact?{artifact}:{}),receipt:{version:2,action:'agent.config',flow,target,operationId:body.operationId,runId:reserved.status.runId,state,at:reserved.status.submittedAt,previous,appliedHash:flowHash(applied)}};
 await settleSubmittedRun(reserved.status.runId,'done',JSON.stringify(result));
 const saved=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});return saved?flowResult(saved):{success:false,state:'indeterminate',receipt:null};
}
