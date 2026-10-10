import {peekModelOwner,readModelOwnerCached,ModelOwnerSnapshot} from './modelOwner';
import {peekUsage,publicId,publicModelId,publicText,readUsage,UsageView} from './usage';
const modelReference=(v:any)=>publicModelId(typeof v==='string'?v.split('@')[0]:v);
const configured=(snapshot:ModelOwnerSnapshot|null)=>{
 const config=snapshot?.config;const agent=config?.agents?.entries?.main||(Array.isArray(config?.agents?.list)?config.agents.list.find((row:any)=>row.id==='main'):undefined)||config?.agents?.defaults;
 const value=agent?.model??config?.agents?.defaults?.model;
 const primary=modelReference(typeof value==='string'?value:value?.primary);
 const fallbackValue=typeof value==='object'?value?.fallbacks??config?.agents?.defaults?.model?.fallbacks:config?.agents?.defaults?.model?.fallbacks;
 const fallbacks=Array.isArray(fallbackValue)?fallbackValue.map((v:any)=>modelReference(v)).filter(Boolean):[];
 const allowed=Array.isArray(agent?.modelPolicy?.allow)?agent.modelPolicy.allow.map(modelReference).filter(Boolean):[];
 return {primary,fallbacks,allowed:[...new Set([...allowed,primary,...fallbacks].filter(Boolean))]};
};
const authState=(status:any):'ready'|'needs_auth'|'unknown'=>['ok','static','expiring'].includes(status)?'ready':['missing','expired','invalid','unauthorized','needs_auth'].includes(status)?'needs_auth':'unknown';
export function projectProviders(snapshot:ModelOwnerSnapshot|null,usage:UsageView|null,fresh=true){
 const configuredModels=configured(snapshot),rows=Array.isArray(snapshot?.catalog?.models)?snapshot!.catalog.models:[];
 const auth=Array.isArray(snapshot?.auth?.providers)?snapshot!.auth.providers:[];
 const ids=[...new Set([...auth.map((a:any)=>publicId(a.provider)),...rows.map((m:any)=>publicId(m.provider)),...(usage?.providers||[]).map(p=>publicId(p.id)),...configuredModels.allowed.map((ref:string)=>publicId(ref.split('/')[0]))].filter((id):id is string=>!!id))].sort();
 const providers=ids.map(id=>{
  const meter=usage?.providers.find(p=>p.id===id);const authentication=fresh?authState(auth.find((a:any)=>a.provider===id)?.status):'unknown';
  const quota=['exhausted','low','ok','unknown'].includes(meter?.state||'')?meter!.state:null;
  const state=authentication==='needs_auth'?'needs_auth':authentication==='ready'?(quota==='exhausted'?'exhausted':quota==='ok'||quota==='low'?'ready':'unknown'):'unknown';
  const models=rows.filter((row:any)=>row.provider===id).flatMap((row:any)=>{
   const model=publicModelId(row.id);if(!model)return [];
   const reference=model.startsWith(id+'/')?model:id+'/'+model;
   if(!configuredModels.allowed.includes(reference)&&!configuredModels.allowed.includes(model))return [];
   const input=Array.isArray(row.input)?row.input:[];
   const capabilities:string[]=[];if(row.reasoning===true)capabilities.push('reasoning');if(input.includes('image'))capabilities.push('image');if(input.includes('video'))capabilities.push('video');
   return [{id:model,name:publicText(row.name)||model,available:typeof row.available==='boolean'?row.available:null,capabilities,contextTokens:Number.isSafeInteger(row.contextTokens)&&row.contextTokens>0?row.contextTokens:null,inUse:configuredModels.primary===reference||configuredModels.primary===model?'primary':configuredModels.fallbacks.some((v:string)=>v===reference||v===model)?'fallback':null}];
  });
  return {id,name:publicText(meter?.name)||id,auth:authentication,quota,state,models};
 });
 return {schemaVersion:1,updatedAt:snapshot?.updatedAt??usage?.updatedAt??null,summary:{ready:providers.filter(p=>p.state==='ready').length,needsAttention:providers.filter(p=>['needs_auth','exhausted'].includes(p.state)).length,unknown:providers.filter(p=>p.state==='unknown').length,configuredModels:providers.reduce((n,p)=>n+p.models.length,0)},providers};
}
export async function readProviders(refresh=false){
 const [owner,usage]=await Promise.all([readModelOwnerCached({refresh}),readUsage()]);
 return projectProviders(owner.snapshot,usage,owner.state==='fresh');
}
export function peekProviders(){const snapshot=peekModelOwner();return projectProviders(snapshot,peekUsage(),!!snapshot&&Date.now()-snapshot.updatedAt<60000);}
export function peekActiveModel(){return configured(peekModelOwner()).primary;}
export function providerAttention(){
 return peekProviders().providers.filter(p=>['exhausted','needs_auth'].includes(p.state)&&p.models.some(m=>m.inUse!==null)).map(p=>({id:'provider:'+p.id,kind:'provider',provider:p.id,state:p.state,agentDependency:true}));
}
