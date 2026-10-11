import {peekModelOwner,readModelOwnerCached,ModelOwnerSnapshot,configuredModelAllow} from './modelOwner';
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
export function projectModelRoles(snapshot:ModelOwnerSnapshot|null){
 const config=snapshot?.config;
 const chain=(value:any)=>{
  const primary=modelReference(typeof value==='string'?value:value?.primary);
  const fallback=Array.isArray(value?.fallbacks)?value.fallbacks.slice(0,20).map(modelReference).filter(Boolean):[];
  return {model:primary??null,fallbacks:[...new Set(fallback)],state:primary?'configured':'unavailable'};
 };
 const main=config?.agents?.entries?.main?.model??config?.agents?.defaults?.model;
 const entry=(id:string)=>config?.agents?.entries?.[id]?.model??config?.agents?.list?.find((row:any)=>row.id===id)?.model;
 const scalar=(value:any)=>chain(value?.model?((value.provider&&!value.model.includes('/'))?value.provider+'/'+value.model:value.model):null);
 const roles=[
  {id:'conversation',...chain(main)},
  {id:'realtime_voice',...scalar(config?.talk?.realtime)},
  {id:'spoken_voice',model:null,fallbacks:[],state:'unavailable'},
  {id:'conversation_summary',...chain(config?.agents?.defaults?.compaction?.model)},
  {id:'memory_search',...scalar(config?.memory?.search)},
  {id:'engineering_learning',...chain(entry('engineering-lite'))},
  {id:'gemini_agent',...chain(entry('gemini'))},
  {id:'routing',model:null,fallbacks:[],state:'deterministic'},
  {id:'immune_system',model:null,fallbacks:[],state:'deterministic',verdictState:'unavailable'},
  {id:'copilot',model:null,fallbacks:[],state:snapshot?.auth?.providers?.some((row:any)=>row.provider==='github-copilot'&&['ok','static','expiring'].includes(row.status))?'connected_not_used':'unavailable'},
 ];
 return roles.map(role=>({...role,source:role.state==='deterministic'?'canonical_capability_contract':role.state==='configured'?'gateway_config':role.state==='connected_not_used'?'gateway_auth':'unavailable'}));
}
const authState=(status:any):'ready'|'needs_auth'|'unknown'=>['ok','static','expiring'].includes(status)?'ready':['missing','expired','invalid','unauthorized','needs_auth'].includes(status)?'needs_auth':'unknown';
export function projectProviders(snapshot:ModelOwnerSnapshot|null,usage:UsageView|null,fresh=true){
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
   if(!configuredModels.allowed.includes(reference)&&!configuredModels.allowed.includes(model))return [];
   const input=Array.isArray(row.input)?row.input:[];
   const capabilities:string[]=[];if(row.reasoning===true)capabilities.push('reasoning');if(input.includes('image'))capabilities.push('image');if(input.includes('video'))capabilities.push('video');
   return [{id:model,name:publicText(row.name)||model,available:typeof row.available==='boolean'?row.available:null,capabilities,contextTokens:Number.isSafeInteger(row.contextTokens)&&row.contextTokens>0?row.contextTokens:Number.isSafeInteger(row.contextWindow)&&row.contextWindow>0?row.contextWindow:null,inUse:configuredModels.primary===reference||configuredModels.primary===model?'primary':configuredModels.fallbacks.some((v:string)=>v===reference||v===model)?'fallback':null}];
  });
  return {id,name:publicText(meter?.name)||id,auth:authentication,quota,state,models};
 });
 return {schemaVersion:1,updatedAt:isoTimestamp(snapshot?.updatedAt)??usage?.updatedAt??null,summary:{ready:providers.filter(p=>p.state==='ready').length,needsAttention:providers.filter(p=>['needs_auth','exhausted'].includes(p.state)).length,unknown:providers.filter(p=>p.state==='unknown').length,configuredModels:providers.reduce((n,p)=>n+p.models.length,0)},roles:projectModelRoles(snapshot),providers};
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
  return projectProviders(cached,await readUsage(),Date.now()-cached.updatedAt<SERVE_MS);
 }
 const [owner,usage]=await Promise.all([readModelOwnerCached({refresh}),readUsage()]);
 return projectProviders(owner.snapshot,usage,!!owner.snapshot&&Date.now()-owner.snapshot.updatedAt<SERVE_MS);
}
export function peekProviders(){const snapshot=peekModelOwner();return projectProviders(snapshot,peekUsage(),!!snapshot&&!snapshot.stale&&Date.now()-snapshot.updatedAt<60000);}
export function peekActiveModel(){const snapshot=peekModelOwner();return snapshot&&!snapshot.stale&&Date.now()-snapshot.updatedAt<60000?configured(snapshot).primary:null;}
export function providerAttention(){
 return peekProviders().providers.filter(p=>['exhausted','needs_auth'].includes(p.state)&&p.models.some(m=>m.inUse!==null)).map(p=>({id:'provider:'+p.id,kind:'provider',provider:p.id,state:p.state,agentDependency:true}));
}
