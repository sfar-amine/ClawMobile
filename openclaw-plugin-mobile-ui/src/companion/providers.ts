import {CLAW_LIVE_MODEL} from './clawLive';
import {MEMO_STT_MODEL} from './memoSttBoundary';
import {PUBLIC_WEB_MODEL} from './runWeb';
import {publicModelRef} from './accountIdentity';
import {readModelFlowTurnLatency} from './control-health';
import {peekModelOwner,readModelOwnerCached,ModelOwnerSnapshot,configuredModelAllow,configuredModelFlow,modelReferenceAllowed} from './modelOwner';
import {isoTimestamp,peekUsage,publicId,publicModelId,publicText,readUsage,UsageView} from './usage';
const modelReference=(v:any)=>publicModelId(typeof v==='string'?v.split('@')[0]:v);
const configured=(snapshot:ModelOwnerSnapshot|null)=>{
 const config=snapshot?.config;const agent=config?.agents?.entries?.main||(Array.isArray(config?.agents?.list)?config.agents.list.find((row:any)=>row.id==='main'):undefined)||config?.agents?.defaults;
 const value=agent?.model??config?.agents?.defaults?.model;
 const primary=modelReference(typeof value==='string'?value:value?.primary);
 const fallbackValue=typeof value==='object'?value?.fallbacks??config?.agents?.defaults?.model?.fallbacks:config?.agents?.defaults?.model?.fallbacks;
 const fallbacks=Array.isArray(fallbackValue)?fallbackValue.map((v:any)=>modelReference(v)).filter(Boolean):[];
 const allowed=configuredModelAllow(config).map(modelReference).filter(Boolean);
 return {primary,fallbacks,allowed:[...new Set([...allowed,primary,...fallbacks].filter(Boolean))]};
};

/** R1: bounded read-only usage projection of the same model/config owner. Unknown paths stay unknown. */
export function projectModelFlowMetrics(id:string,latency:any=null){
 const window=latency?.windows?.['7d'],wa=window?.surfaces?.find((row:any)=>row.surface==='whatsapp');
 const measured=id==='whatsapp'&&wa&&Number.isSafeInteger(wa.usefulSamples)&&wa.usefulSamples>0&&Number.isFinite(wa.medianUsefulMs)&&wa.medianUsefulMs>=0;
 return {windowDays:7,notThisRate:null,notThisReason:'feedback_not_correlated',latencyMedianMs:measured?wa.medianUsefulMs:null,
  state:measured?'measured':'unavailable',latencyReason:measured?null:id==='whatsapp'?'native_measurements_unavailable':'model_flow_not_attributed',
  usefulSamples:measured?wa.usefulSamples:0,measurementCoverage:'observed_only',retentionComplete:typeof window?.retentionComplete==='boolean'?window.retentionComplete:null,source:'runs'};
}
export function projectModelRoles(snapshot:ModelOwnerSnapshot|null,latency:any=null){
 const config=snapshot?.config;
 const account=(value:any)=>typeof value==='string'&&value.includes('@')?publicModelRef(value)!.split('@')[1]:null;
 const chain=(value:any)=>{
  const raw=typeof value==='string'?value:value?.primary,primary=modelReference(raw);
  const fallback=Array.isArray(value?.fallbacks)?value.fallbacks.slice(0,20):[];
  return {model:primary??null,profile:account(raw),fallbacks:[...new Set(fallback.map(modelReference).filter(Boolean))],fallbackProfiles:fallback.map((ref:any)=>({model:modelReference(ref)??null,profile:account(ref)})),state:primary?'configured':'unavailable'};
 };
 const editable=(id:'brain'|'conversation_summary'|'whatsapp')=>{
  const value=configuredModelFlow(config,id),active=process.env.SAMANTHA_BRAIN_ONLY==='1';
  return {id,...chain(value.model),thinking:value.thinkingDefault??null,fastMode:typeof value.fastModeDefault==='boolean'?value.fastModeDefault:null,source:'gateway_config',inheritsFrom:value.inheritsFrom,origins:value.origins,mixedFields:value.mixedFields,...(value.inheritsFrom==='conversation'?{state:'runtime_inherited'}:{}),...(value.mixedFields.length?{state:'mixed'}:{}),editable:active&&!!snapshot,editableReason:active?(snapshot?null:'model_owner_unavailable'):'brain_only_not_active',writeFields:id==='conversation_summary'?['model']:['model','fallbacks','thinking','fastMode']};
 };
 const readonly=(id:string,value:any,source:string,reason='next_lot',extra:any={})=>({id,...chain(value),thinking:null,fastMode:null,source,inheritsFrom:null,editable:false,editableReason:reason,writeFields:[],...extra});
 const voice=config?.talk?.realtime,voiceMalformed=voice?.model!==undefined&&voice?.model!==null&&typeof voice.model!=='string';
 const voiceModel=voiceMalformed?null:typeof voice?.model==='string'?(voice.model.includes('/')?voice.model:(voice.provider||'google')+'/'+voice.model):'google/'+CLAW_LIVE_MODEL;
 const spokenProvider=publicId(config?.talk?.provider),spokenVoice=publicModelId(config?.talk?.providers?.[spokenProvider??'']?.voice);
 const memory=config?.memory?.search,memoryProvider=publicId(memory?.provider),memoryModel=typeof memory?.model==='string'?(memory.model.includes('/')?memory.model:(memoryProvider?memoryProvider+'/':'')+memory.model):null;
 const engineering=config?.agents?.entries?.['engineering-lite']?.model;
 const policy=snapshot?.policy;
 return [
  editable('brain'),
  readonly('web_search',PUBLIC_WEB_MODEL,'code_constant','next_lot',{inheritsFrom:'brain'}),
  editable('conversation_summary'),
  readonly('memory_search',memoryModel,'gateway_config','next_lot',{provider:memoryProvider??null,state:memoryModel?'configured':memoryProvider?'provider_default':'unavailable'}),
  readonly('realtime_voice',voiceModel,typeof voice?.model==='string'?'gateway_config':'code_constant','next_lot',{provider:voice?.provider??'google'}),
  readonly('spoken_voice',spokenProvider&&spokenVoice?spokenProvider+'/'+spokenVoice:null,'gateway_config'),
  readonly('dictation',null,'device','device_managed',{state:'device_managed'}),
  readonly('voice_memos','google/'+MEMO_STT_MODEL,'code_constant'),
  readonly('immune_system',policy?.primary??null,'model_policy',policy?'next_lot':'model_policy_unavailable',{fallbacks:policy?.fallback?[modelReference(policy.fallback)]:[],policySourceHash:policy?.sourceHash??null}),
  readonly('engineering_learning',engineering??null,'gateway_config','next_lot',{inheritsFrom:'immune_system'}),
  editable('whatsapp'),
 ].map(role=>({...role,provider:'provider' in role?role.provider:typeof role.model==='string'?role.model.split('/')[0]:null,metrics:projectModelFlowMetrics(role.id,latency)}));
}

const authState=(status:any):'ready'|'needs_auth'|'unknown'=>['ok','static','expiring'].includes(status)?'ready':['missing','expired','invalid','unauthorized','needs_auth'].includes(status)?'needs_auth':'unknown';
export function projectProviders(snapshot:ModelOwnerSnapshot|null,usage:UsageView|null,fresh=true,latency:any=null){
 const policyAllow=configuredModelAllow(snapshot?.config);
 const configuredModels=configured(snapshot),rows=Array.isArray(snapshot?.catalog?.models)?snapshot!.catalog.models:[];
 const auth=Array.isArray(snapshot?.auth?.providers)?snapshot!.auth.providers:[];
 const ids=[...new Set([...auth.map((a:any)=>publicId(a.provider)),...rows.map((m:any)=>publicId(m.provider)),...(usage?.providers||[]).map(p=>publicId(p.id)),...configuredModels.allowed.map((ref:string)=>publicId(ref.split('/')[0]))].filter((id):id is string=>!!id))].sort();
 const providers=ids.map(id=>{
  const meter=usage?.providers.find(p=>p.id===id);const authentication=fresh?authState(auth.find((a:any)=>a.provider===id)?.status):'unknown';
  const quota=['exhausted','low','ok','unknown'].includes(meter?.state||'')?meter!.state:null;
  const state=authentication==='needs_auth'?'needs_auth':authentication==='ready'?(quota==='exhausted'?'exhausted':quota==='ok'||quota==='low'||quota===null&&snapshot?.catalog?.providerOutcomes?.some((row:any)=>row.provider===id&&row.status==='ready')?'ready':'unknown'):'unknown';
  const models=rows.filter((row:any)=>row.provider===id).flatMap((row:any)=>{
   const model=publicModelId(row.id);if(!model)return [];
   const reference=model.startsWith(id+'/')?model:id+'/'+model;
   if(!configuredModels.allowed.includes(reference)&&!configuredModels.allowed.includes(model)&&!modelReferenceAllowed(policyAllow,reference))return [];
   const input=Array.isArray(row.input)?row.input:[];
   const capabilities:string[]=[];if(row.reasoning===true)capabilities.push('reasoning');if(input.includes('image'))capabilities.push('image');if(input.includes('video'))capabilities.push('video');
   return [{id:model,name:publicText(row.name)||model,available:typeof row.available==='boolean'?row.available:null,capabilities,contextTokens:Number.isSafeInteger(row.contextTokens)&&row.contextTokens>0?row.contextTokens:Number.isSafeInteger(row.contextWindow)&&row.contextWindow>0?row.contextWindow:null,inUse:configuredModels.primary===reference||configuredModels.primary===model?'primary':configuredModels.fallbacks.some((v:string)=>v===reference||v===model)?'fallback':null}];
  });
  return {id,name:publicText(meter?.name)||id,auth:authentication,quota,state,models};
 });
 return {schemaVersion:1,updatedAt:isoTimestamp(snapshot?.updatedAt)??usage?.updatedAt??null,summary:{ready:providers.filter(p=>p.state==='ready').length,needsAttention:providers.filter(p=>['needs_auth','exhausted'].includes(p.state)).length,unknown:providers.filter(p=>p.state==='unknown').length,configuredModels:providers.reduce((n,p)=>n+p.models.length,0)},roles:projectModelRoles(snapshot,latency).map(role=>({...role,providerState:providers.find(row=>row.id===role.provider)?.state??'unknown',quotaState:usage?.providers.find(row=>row.id===role.provider)?.state??'unknown'})),providers};
}
const SERVE_MS=300000;
export async function readProviders(refresh=false){
 const cached=peekModelOwner();
 if(cached&&!refresh){
  // The shared R6/R11 owner keeps refreshing in single-flight; cached metadata
  // avoids putting its 4.8s CLI read back on an ordinary providers request.
  // A successful snapshot stays authoritative for five minutes while that
  // refresh runs; a failed or older owner read degrades to unknown.
  void readModelOwnerCached().catch(()=>{});
  // 10/10 20:45 (S24): one failed background refresh (CLI budget lost under parallel reads) marked the
  // snapshot stale and every provider became unknown (0/0/4) until a later refresh succeeded. Only the
  // snapshot's own age voids it; `stale` is the last attempt, not this successful read.
  const [usage,latency]=await Promise.all([readUsage(),readModelFlowTurnLatency()]);
  return projectProviders(cached,usage,Date.now()-cached.updatedAt<SERVE_MS,latency);
 }
 const [owner,usage,latency]=await Promise.all([readModelOwnerCached({refresh}),readUsage(),readModelFlowTurnLatency()]);
 return projectProviders(owner.snapshot,usage,!!owner.snapshot&&Date.now()-owner.snapshot.updatedAt<SERVE_MS,latency);
}
export function peekProviders(){const snapshot=peekModelOwner();return projectProviders(snapshot,peekUsage(),!!snapshot&&!snapshot.stale&&Date.now()-snapshot.updatedAt<60000);}
export function peekActiveModel(){const snapshot=peekModelOwner();return snapshot&&!snapshot.stale&&Date.now()-snapshot.updatedAt<60000?configured(snapshot).primary:null;}
export function providerAttention(){
 return peekProviders().providers.filter(p=>['exhausted','needs_auth'].includes(p.state)&&p.models.some(m=>m.inUse!==null)).map(p=>({id:'provider:'+p.id,kind:'provider',provider:p.id,state:p.state,agentDependency:true}));
}
