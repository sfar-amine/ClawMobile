import {callOpenClawGateway} from './openclawAgentClient';
export type QuotaState='exhausted'|'low'|'ok'|'unknown';
export type UsageWindow={label:string|null;usedPercent:number|null;remainingPercent:number|null;resetsAt:number|null};
export type UsageProvider={id:string;name:string|null;plan:string|null;windows:UsageWindow[];state:QuotaState};
export type UsageView={schemaVersion:1;updatedAt:number|null;providers:UsageProvider[];issues:string[]};
const plain=(v:any)=>!!v&&typeof v==='object'&&!Array.isArray(v);
const forbidden=/@|\b[a-z][a-z0-9+.-]*:(?:\/\/|\/|[^\s])|\bwww\.|\bBearer\b|\bsk-[A-Za-z0-9_-]+|\bgh[pousr]_|\bgithub_pat_|\b(?:AKIA|ASIA)[A-Z0-9]{16}|\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|(?:access|refresh)[_-]?token|\b(?:api[_-]?key|password|authorization|credential|secret)\b|-----BEGIN|[\x00-\x1f\x7f]/i;
export const publicText=(v:any,max=120):string|null=>typeof v==='string'&&v.length>0&&Array.from(v).length<=max&&!forbidden.test(v)?v:null;
export const publicId=(v:any):string|null=>typeof v==='string'&&/^[a-z][a-z0-9_.-]{0,79}$/.test(v)&&publicText(v,80)?v:null;
export const publicModelId=(v:any):string|null=>typeof v==='string'&&/^[A-Za-z0-9_.:/+-]{1,200}$/.test(v)&&publicText(v,200)?v:null;
const number=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const timestamp=(v:any)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:null;
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
  const windows=raw.map((w:any)=>{const used=number(w?.usedPercent);return {label:publicText(w?.label),usedPercent:used,remainingPercent:used===null?null:Math.max(0,100-used),resetsAt:timestamp(w?.resetAt)};});
  providers.push({id,name:publicText(row.displayName),plan:publicText(row.plan),windows,state:quotaState(windows)});
 }
 return {schemaVersion:1,updatedAt:timestamp(value.updatedAt),providers,issues:[...new Set(issues)]};
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
// No cost response schema has been captured. Explicit read only, no guessed fields.
export async function readUsageCost(){
 if(costCache&&Date.now()-costCache.at<ttl)return structuredClone(costCache.view);
 if(costPending)return structuredClone(await costPending);
 // days:30 is attested by public OpenClaw2026.9.6 source. The canonical
 // summary is aggregate-only: never manufacture a provider cost breakdown.
 costPending=(async()=>{try{
  await callOpenClawGateway('usage.cost',{days:30},{timeoutMs:5500,hardTimeoutMs:5500});
  return {schemaVersion:1,state:'unqualified',periodDays:30,providers:[],issues:['usage_cost_provider_breakdown_unavailable']};
 }catch{return {schemaVersion:1,state:'unavailable',periodDays:30,providers:[],issues:['usage_cost_source_unavailable']};}})();
 try{const view=await costPending;costCache={at:Date.now(),view};return structuredClone(view);}finally{costPending=null;}
}

export function usageAttention(view:UsageView|null,model:string|null){
 if(!view)return [];
 const activeProvider=publicModelId(model)?.split('/')[0]||null;
 return view.providers.filter(p=>p.state==='exhausted').map(p=>({id:'usage:'+p.id,kind:'usage',provider:p.id,state:'exhausted',activeAgentDependency:activeProvider===p.id}));
}
