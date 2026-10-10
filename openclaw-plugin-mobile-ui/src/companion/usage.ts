import {callOpenClawGateway} from './openclawAgentClient';
export type QuotaState='exhausted'|'low'|'ok'|'unknown';
export type UsageWindow={label:string|null;usedPercent:number|null;remainingPercent:number|null;resetsAt:string|null};
export type UsageProvider={id:string;name:string|null;plan:string|null;windows:UsageWindow[];state:QuotaState};
export type UsageView={schemaVersion:1;updatedAt:string|null;providers:UsageProvider[];issues:string[]};
const plain=(v:any)=>!!v&&typeof v==='object'&&!Array.isArray(v);
const forbidden=/@|\b[a-z][a-z0-9+.-]*:(?:\/\/|\/|[^\s])|\bwww\.|\bBearer\b|\bsk-[A-Za-z0-9_-]+|\bgh[pousr]_|\bgithub_pat_|\b(?:AKIA|ASIA)[A-Z0-9]{16}|\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|(?:access|refresh)[_-]?token|\b(?:api[_-]?key|password|authorization|credential|secret)\b|-----BEGIN|[\x00-\x1f\x7f]/i;
export const publicText=(v:any,max=120):string|null=>typeof v==='string'&&v.length>0&&Array.from(v).length<=max&&!forbidden.test(v)?v:null;
export const publicId=(v:any):string|null=>typeof v==='string'&&/^[a-z][a-z0-9_.-]{0,79}$/.test(v)&&publicText(v,80)?v:null;
export const publicModelId=(v:any):string|null=>typeof v==='string'&&/^[A-Za-z0-9_.:/+-]{1,200}$/.test(v)&&publicText(v,200)?v:null;
const number=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const timestamp=(v:any)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:null;
/** Contract and app: ISO 8601 UTC (the Gateway gives epoch milliseconds). */
export const isoTimestamp=(v:any):string|null=>{const ms=timestamp(v);return ms!==null&&ms<=8640000000000000?new Date(ms).toISOString():null;};
export function quotaState(windows:UsageWindow[]):QuotaState{
 if(windows.some(w=>w.usedPercent!==null&&w.usedPercent>=100))return 'exhausted';
 if(!windows.length||windows.some(w=>w.usedPercent===null))return 'unknown';
 return windows.some(w=>w.usedPercent!>=80)?'low':'ok';
}
export function projectUsage(value:any):UsageView{
 const issues:string[]=[];
 if(!plain(value)||!Array.isArray(value.providers)||value.providers.length>100)return {schemaVersion:1,updatedAt:null,providers:[],issues:['usage_shape_unqualified']};
 const providers:UsageProvider[]=[];const ids=new Set<string>();
 for(const row of value.providers){
  const id=publicId(row?.provider);if(!id||ids.has(id)){issues.push('usage_provider_unqualified');continue;}ids.add(id);
  const raw=Array.isArray(row.windows)&&row.windows.length<=30?row.windows:[];
  if(!raw.length)issues.push('usage_windows_unqualified');
  const windows=raw.map((w:any)=>{const used=number(w?.usedPercent);return {label:publicText(w?.label),usedPercent:used,remainingPercent:used===null?null:Math.max(0,100-used),resetsAt:isoTimestamp(w?.resetAt)};});
  providers.push({id,name:publicText(row.displayName),plan:publicText(row.plan),windows,state:quotaState(windows)});
 }
 return {schemaVersion:1,updatedAt:isoTimestamp(value.updatedAt),providers,issues:[...new Set(issues)]};
}
const ttl=60000;
let cache:{view:UsageView;at:number}|null=null;
let pending:Promise<UsageView>|null=null;
let costPending:Promise<any>|null=null;
let costCache:{at:number;view:any}|null=null;
export function peekUsage():UsageView|null{return cache&&Date.now()-cache.at<ttl?structuredClone(cache.view):null;}
export async function readUsage():Promise<UsageView>{
 const current=peekUsage();if(current)return current;if(pending)return structuredClone(await pending);
 pending=(async()=>{try{const value=projectUsage(await callOpenClawGateway('usage.status',{}, {timeoutMs:5500,hardTimeoutMs:5500}));cache={view:value,at:Date.now()};return value;}catch{const view:UsageView={schemaVersion:1,updatedAt:null,providers:[],issues:['usage_source_unavailable']};cache={view,at:Date.now()};return view;}})();
 try{return structuredClone(await pending);}finally{pending=null;}
}
const COST_TTL_MS=600000;
const costMetrics=['input','output','cacheRead','cacheWrite','totalTokens','totalCost','inputCost','outputCost','cacheReadCost','cacheWriteCost','missingCostEntries'] as const;
/** Global owner totals only. Stale files mean computing, never a zero-cost claim. */
export function projectUsageCost(value:any){
 const base={schemaVersion:1,periodDays:30};
 if(!plain(value)||value.days!==30||!plain(value.cacheStatus))return {...base,state:'unqualified',issues:['usage_cost_shape_unqualified']};
 if(value.cacheStatus.staleFiles>0||value.cacheStatus.pendingFiles>0||['refreshing','stale','partial','computing'].includes(value.cacheStatus.status))return {...base,state:'computing'};
 if(value.cacheStatus.status!=='fresh'||!Number.isSafeInteger(value.cacheStatus.staleFiles)||value.cacheStatus.staleFiles!==0||!Number.isSafeInteger(value.cacheStatus.pendingFiles)||value.cacheStatus.pendingFiles!==0)return {...base,state:'unqualified',issues:['usage_cost_cache_unqualified']};
 if(!Array.isArray(value.daily)||value.daily.length>30||!plain(value.totals))return {...base,state:'unqualified',issues:['usage_cost_shape_unqualified']};
 const metrics=(row:any)=>Object.fromEntries(costMetrics.map(key=>[key,number(row?.[key])]));
 const daily=value.daily.map((row:any)=>({date:typeof row?.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.date)?row.date:null,...metrics(row)}));
 if(daily.some(row=>row.date===null)||number(value.totals.totalCost)===null)return {...base,state:'unqualified',issues:['usage_cost_shape_unqualified']};
 return {...base,state:'ok',updatedAt:isoTimestamp(value.updatedAt),totals:metrics(value.totals),daily};
}
/**
 * The Gateway answers `refreshing` while it recomputes its cost cache in the
 * background and keeps that answer 30 s (USAGE_CACHE_TTL_MS, OpenClaw 2026.9.6).
 * Holding `computing` for the ten-minute cost TTL made it last forever on an
 * active phone (every new read found freshly written sessions). Computing is
 * therefore re-read after 15 s, the last real total stays visible while the
 * Gateway refreshes (at most 30 min old, `refreshing:true`), and without such a
 * total the answer becomes `unavailable` with its reason after two minutes
 * instead of an endless spinner.
 */
export const COST_COMPUTING_RETRY_MS=15000,COST_COMPUTING_MAX_MS=120000;
const COST_FAILURE_TTL_MS=60000,COST_LAST_OK_MS=1800000;
let costComputingSince:number|null=null,lastCostOk:{at:number;view:any}|null=null;
function settleCost(view:any){
 const now=Date.now();
 if(view?.state!=='computing'){costComputingSince=null;if(view?.state==='ok')lastCostOk={at:now,view};return view;}
 costComputingSince??=now;
 if(lastCostOk&&now-lastCostOk.at<COST_LAST_OK_MS)return {...structuredClone(lastCostOk.view),refreshing:true};
 if(now-costComputingSince>=COST_COMPUTING_MAX_MS)return {schemaVersion:1,state:'unavailable',periodDays:30,reason:'usage_cost_refresh_timeout',computingSince:new Date(costComputingSince).toISOString(),issues:['usage_cost_refresh_timeout']};
 return {...view,computingSince:new Date(costComputingSince).toISOString(),retryAfterMs:COST_COMPUTING_RETRY_MS};
}
const costTtl=(view:any)=>view?.state==='ok'&&!view.refreshing?COST_TTL_MS:view?.state==='computing'||view?.refreshing?COST_COMPUTING_RETRY_MS:COST_FAILURE_TTL_MS;
export async function readUsageCost(){
 if(costCache&&Date.now()-costCache.at<costTtl(costCache.view))return structuredClone(costCache.view);
 if(costPending)return structuredClone(await costPending);
 costPending=(async()=>{try{return settleCost(projectUsageCost(await callOpenClawGateway('usage.cost',{days:30},{timeoutMs:10000,hardTimeoutMs:10500})));}
 catch{return {schemaVersion:1,state:'unavailable',periodDays:30,issues:['usage_cost_source_unavailable']};}})();
 try{const view=await costPending;costCache={at:Date.now(),view};return structuredClone(view);}finally{costPending=null;}
}

/** Explicit cost query only: independent ten-minute cache and twelve-second route budget. */
export async function readUsageDetails(){
 let timer:ReturnType<typeof setTimeout>|undefined;
 const reads=Promise.all([readUsage(),readUsageCost()]).then(([base,cost])=>({...base,cost}));
 const bounded=new Promise<UsageView&{cost:any}>(resolve=>{timer=setTimeout(()=>resolve({
  ...(peekUsage()||{schemaVersion:1 as const,updatedAt:null,providers:[],issues:['usage_source_unavailable']}),
  cost:{schemaVersion:1,state:'unavailable',periodDays:30,issues:['usage_cost_budget_exceeded']}
 }),12000);});
 try{return await Promise.race([reads,bounded]);}finally{if(timer)clearTimeout(timer);}
}

export function usageAttention(view:UsageView|null,model:string|null){
 if(!view)return [];
 const activeProvider=publicModelId(model)?.split('/')[0]||null;
 return view.providers.filter(p=>p.state==='exhausted').map(p=>({id:'usage:'+p.id,kind:'usage',provider:p.id,state:'exhausted',activeAgentDependency:activeProvider===p.id}));
}
