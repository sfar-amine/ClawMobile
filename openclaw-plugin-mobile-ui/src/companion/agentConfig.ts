import crypto from "crypto";
import {readModelOwnerFresh} from "./modelOwner";
import {confirmations} from "./confirmations";
import {callOpenClawGateway} from "./openclawAgentClient";
import {readPaymentRequests,readOwnerConfirmations} from "./runs";
import {findSubmittedRunByClientRunId,reserveSubmittedRun,settleSubmittedRun} from "./runs";
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
function modelList(value:any,config:any,auth:any){
 if(!Array.isArray(value?.models)||value.models.length>2000)throw nativeError('agent_models_unavailable',503);
 const allow=config.agents?.entries?.main?.modelPolicy?.allow;
 if(!Array.isArray(allow))return [];
 return value.models.flatMap((row:any)=>{
  const ref=row?.id?.startsWith(row?.provider+'/')?row.id:row?.provider+'/'+row?.id;
  const plugin=config.plugins?.entries?.[row?.provider];
  const levels=Array.isArray(row?.thinkingLevels)?row.thinkingLevels.map((x:any)=>x?.id).filter((x:any)=>thinkingLevels.includes(x)):['off'];
  return identifier.test(row?.id||'')&&identifier.test(row?.provider||'')&&allow.includes(ref.split('@')[0])&&plugin?.enabled!==false&&row?.available===true&&validProvider(auth,row.provider)?[{id:row.id,provider:row.provider,reasoning:row.reasoning===true,thinkingLevels:levels}]:[];
 });
}
function validProvider(auth:any,provider:string,profile?:string){
 if(auth?.unavailable||!Array.isArray(auth?.providers))return false;
 const row=auth.providers.find((x:any)=>x.provider===provider);
 return !!row&&['ok','static','expiring'].includes(row.status)&&(!profile||row.profiles?.some((x:any)=>x.profileId===profile&&['ok','static','expiring'].includes(x.status)));
}
const count=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export async function readAgentConfig(){
 const [{raw,catalog,auth},usage]=await Promise.all([readModelOwnerFresh(),callOpenClawGateway('sessions.usage',{limit:100}).catch(()=>null)]);
 const config=configObject(raw),id=modelId(config);
 const chosen=selection(config).value;
 const model=chosen.model??config.agents?.defaults?.model;
 const fallbackValue=typeof model==='object'?model?.fallbacks??config.agents?.defaults?.model?.fallbacks:config.agents?.defaults?.model?.fallbacks;
 const fallbacks=Array.isArray(fallbackValue)&&fallbackValue.length<=20?fallbackValue.filter((row:any)=>typeof row==='string'&&identifier.test(row)):null;
 const toolPolicy=(value:any)=>({profile:['minimal','coding','messaging','full'].includes(value?.profile)?value.profile:null,allow:Array.isArray(value?.allow)&&value.allow.length<=100?value.allow.filter((x:any)=>typeof x==='string'&&/^[A-Za-z0-9_.*:-]{1,100}$/.test(x)):null,deny:Array.isArray(value?.deny)&&value.deny.length<=100?value.deny.filter((x:any)=>typeof x==='string'&&/^[A-Za-z0-9_.*:-]{1,100}$/.test(x)):null});
 return {success:true,state:'ok',receipt:null,schemaVersion:1,revision:raw.hash,agentId:'main',model:id,provider:id?.includes('/')?id.split('/')[0]:null,
  fallbacks,tools:{global:toolPolicy(config.tools),agent:toolPolicy(chosen.tools),effective:null,reason:'effective_tool_catalog_unavailable'},
  thinking:level(config),thinkingLevels,models:modelList(catalog,config,auth),writeAvailable:selection(config).writeAvailable&&modelList(catalog,config,auth).length>0,issues:modelList(catalog,config,auth).length?[]:['model_authentication_proof_unavailable'],
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
 const {raw,catalog,auth}=await readModelOwnerFresh();const config=configObject(raw);
 if(raw.hash!==body.revision)throw nativeError('agent_config_revision_changed',409);
 if(!selection(config).writeAvailable)throw nativeError('agent_config_owner_shape_unsupported',409);
 const models=modelList(catalog,config,auth),found=models.find((row:any)=>row.id===body.model&&row.provider===body.provider);
 if(!found||!found.thinkingLevels.includes(body.thinking))throw nativeError('unsupported_agent_model',409);
 const refs=models.map((row:any)=>row.id.startsWith(row.provider+'/')?row.id:row.provider+'/'+row.id);
 const currentFallbacks=selection(config).value.model?.fallbacks||[];
 if(body.fallbacks?.some((ref:string)=>!currentFallbacks.includes(ref)&&(!refs.includes(ref.split('@')[0])||ref.includes('@')&&!validProvider(auth,ref.split('/')[0],ref.split('@')[1]))))throw nativeError('unsupported_agent_fallback',409);
 if(await protectedActivity())throw nativeError('protected_owner_activity',409);
 const id=body.model.startsWith(body.provider+'/')?body.model:body.provider+'/'+body.model;
 const values={model:{primary:id,...('fallbacks' in body?{fallbacks:body.fallbacks}:{})},thinkingDefault:body.thinking};
 const patch={agents:{entries:{main:values}}};
 const oldFallbacks=selection(config).value.model?.fallbacks||[];
 const expanded=body.fallbacks?.some((ref:string)=>!oldFallbacks.includes(ref)&&ref.split('/')[0]!==id.split('/')[0]||ref.includes('@')&&!oldFallbacks.includes(ref));
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
   if(modelId(effective)===id&&level(effective)===body.thinking&&(!('fallbacks' in body)||JSON.stringify(effectiveModel?.fallbacks)===JSON.stringify(body.fallbacks))){state='completed';artifact={configurationRevision:verified.hash,agentId:'main'};}
   }
  }
 }catch{/* No proof: never repeat a possible configuration effect. */}
 const result={success:state==='completed',state,...(artifact?{artifact}:{}),receipt:{version:1,action:'agent.config',target,operationId:body.operationId,runId:reserved.status.runId,state,at:reserved.status.submittedAt}};
 await settleSubmittedRun(reserved.status.runId,'done',JSON.stringify(result));
 const saved=await findSubmittedRunByClientRunId(clientId,{text:identity,sessionId});
 return saved?stored(saved):{success:false,state:'indeterminate',receipt:null};
}
