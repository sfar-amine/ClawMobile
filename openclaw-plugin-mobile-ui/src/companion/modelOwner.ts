import {callOpenClawGateway} from "./openclawAgentClient";

// Process-local projection of the existing Gateway owners. No credential or
// whole config/auth object is retained; fresh mutation reads keep their own
// validation, CAS and dispatch rules in the consumer.
export type ModelOwnerRead={raw:any,catalog:any,auth:any};
export type ModelOwnerSnapshot={config:any,catalog:any,auth:any,revision:string|null,updatedAt:number,stale?:boolean};
export type CachedModelOwner={snapshot:ModelOwnerSnapshot|null,state:"fresh"|"stale"|"unknown",refreshThrottled:boolean};
const CACHE_MS=60000,REFRESH_MS=30000;
let lastExplicitRefreshAt=-Infinity,nextCachedReadAt=0;
let flight:Promise<ModelOwnerRead>|undefined;
let snapshot:ModelOwnerSnapshot|null=null,lastReadFailed=false;
const sensitive=/Bearer\s|(?:api[_-]?key|token|secret|password)\s*[:=]|sk-[A-Za-z0-9_-]{16,}|(?:ghp_|github_pat_)[A-Za-z0-9_]{16,}/i;
const text=(value:any,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&!sensitive.test(value)&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(value)?value:undefined;
const identity=(value:any,max=200)=>typeof value==='string'&&value.length<=max&&!sensitive.test(value)&&/^[A-Za-z0-9._:/+@-]+$/.test(value)&&!value.includes('://')?value:undefined;
const publicName=(value:any)=>text(value,160)&&!/@|:\/\//.test(value)?text(value,160):undefined;
const authState=(value:any)=>["ok","static","expiring","expired","missing"].includes(value)?value:"unknown";
function strings(value:any,maxItems:number,maxLength:number){
 return Array.isArray(value)&&value.length<=maxItems?value.map(x=>text(x,maxLength)).filter(x=>x!==undefined):undefined;
}
function tools(value:any){
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 return {profile:['minimal','coding','messaging','full'].includes(value.profile)?value.profile:undefined,
  allow:strings(value.allow,100,100)?.filter(x=>/^[A-Za-z0-9_.*:-]+$/.test(x!)),deny:strings(value.deny,100,100)?.filter(x=>/^[A-Za-z0-9_.*:-]+$/.test(x!))};
}
function model(value:any){
 if(typeof value==='string')return identity(value);
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 return {primary:identity(value.primary),fallbacks:Array.isArray(value.fallbacks)&&value.fallbacks.length<=20?value.fallbacks.map((x:any)=>identity(x)).filter((x:any)=>x!==undefined):undefined};
}
function agent(value:any){
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 return {model:model(value.model),thinkingDefault:text(value.thinkingDefault,40),tools:tools(value.tools),
  modelPolicy:{allow:strings(value.modelPolicy?.allow,2000,200)?.filter(x=>identity(x))}};
}
function projected(value:ModelOwnerRead):ModelOwnerSnapshot|null{
 const config=value.raw?.config;
 if(!config||typeof config!=='object'||Array.isArray(config)||!Array.isArray(value.catalog?.models)||value.catalog.models.length>2000||value.auth?.unavailable||!Array.isArray(value.auth?.providers)||value.auth.providers.length>2000)return null;
 const entries=config.plugins?.entries,plugins:Record<string,{enabled:boolean}>=Object.create(null);
 if(entries&&typeof entries==='object'&&!Array.isArray(entries))for(const key of Object.keys(entries).slice(0,2000))if(/^[A-Za-z0-9._+-]{1,200}$/.test(key)&&typeof entries[key]?.enabled==='boolean')plugins[key]={enabled:entries[key].enabled};
 const models=value.catalog.models.flatMap((row:any)=>{
  const id=identity(row?.id),provider=typeof row?.provider==='string'&&/^[A-Za-z0-9._+-]{1,200}$/.test(row.provider)?row.provider:undefined;
  if(!id||!provider)return [];
  return [{id,provider,...(publicName(row.name)?{name:publicName(row.name)}:{}),
   ...(Number.isSafeInteger(row.contextTokens)&&row.contextTokens>0?{contextTokens:row.contextTokens}:{}),
   ...(Number.isSafeInteger(row.contextWindow)&&row.contextWindow>0?{contextWindow:row.contextWindow}:{}),
   ...(Array.isArray(row.input)&&row.input.length<=16?{input:row.input.filter((x:any)=>['text','image','audio','video','document'].includes(x))}:{}),
   ...(typeof row.available==='boolean'?{available:row.available}:{}),...(typeof row.reasoning==='boolean'?{reasoning:row.reasoning}:{}),
   ...(Array.isArray(row.thinkingLevels)&&row.thinkingLevels.length<=32?{thinkingLevels:row.thinkingLevels.flatMap((level:any)=>{const id=text(level?.id,40);return id?[{id}]:[];})}:{})}];
 });
 let profileCount=0;
 for(const row of value.auth.providers)if(Array.isArray(row?.profiles)){profileCount+=row.profiles.length;if(profileCount>2000)return null;}
 const providers=value.auth.providers.flatMap((row:any)=>{
  const provider=typeof row?.provider==='string'&&/^[A-Za-z0-9._+-]{1,200}$/.test(row.provider)?row.provider:undefined,status=authState(row?.status);
  if(!provider||!status)return [];
  return [{provider,status,...(publicName(row.displayName)?{displayName:publicName(row.displayName)}:{}),...(Array.isArray(row.profiles)&&row.profiles.length<=2000?{profiles:row.profiles.flatMap((profile:any)=>{const profileId=typeof profile?.profileId==='string'&&/^[A-Za-z0-9._:+-]{1,128}$/.test(profile.profileId)?profile.profileId:undefined,status=authState(profile?.status);return profileId&&status?[{profileId,status}]:[];})}:{})}];
 });
 return {config:{agents:{entries:{main:agent(config.agents?.entries?.main)},defaults:agent(config.agents?.defaults),...(Array.isArray(config.agents?.list)&&config.agents.list.length<=100?{list:config.agents.list.filter((row:any)=>row?.id==='main').slice(0,1).map((row:any)=>({id:'main',...agent(row)}))}:{})},plugins:{entries:plugins},tools:tools(config.tools)},catalog:{models,providerOutcomes:Array.isArray(value.catalog.providerOutcomes)&&value.catalog.providerOutcomes.length<=2000?value.catalog.providerOutcomes.flatMap((row:any)=>typeof row?.provider==='string'&&/^[A-Za-z0-9._+-]{1,200}$/.test(row.provider)&&['ready','needs_auth','unknown'].includes(row.status)?[{provider:row.provider,status:row.status}]:[]):[]},auth:{providers},revision:text(value.raw.hash)||null,updatedAt:Date.now()};
}

/** Explicit fresh owner read; concurrent consumers share only the in-flight read. */
export async function readModelOwnerFresh(options:{budgetMs?:number}={}):Promise<ModelOwnerRead>{
 if(flight)return flight;
 const budgetMs=options.budgetMs??10000;
 if(!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>10000)throw Error("model_owner_budget_invalid");
 const budget={timeoutMs:budgetMs,hardTimeoutMs:budgetMs};
 flight=(async()=>{
  const [raw,catalog,auth]=await Promise.all([
   callOpenClawGateway('config.get',{},budget),
   callOpenClawGateway('models.list',{agentId:'main',includeDetails:true},budget),
   callOpenClawGateway('models.authStatus',{agentId:'main'},budget).catch(()=>null)
  ]);
  const value={raw,catalog,auth},next=projected(value);
  lastReadFailed=next===null;
  if(next)snapshot=next;
  return value;
 })();
 try{return await flight;}catch(error){lastReadFailed=true;throw error;}finally{flight=undefined;}
}

/** No I/O: GET consumers can keep the last successful owner projection. */
export function peekModelOwner():ModelOwnerSnapshot|null{
 return snapshot?JSON.parse(JSON.stringify({...snapshot,stale:lastReadFailed})):null;
}

/** Explicit pre-load, for the existing startup/read paths, never a new timer. */
export async function refreshModelOwner():Promise<boolean>{
 const previous=snapshot;
 try{await boundedRead(readModelOwnerFresh({budgetMs:5500}));return snapshot!==previous;}catch{return false;}
}

/** Shared read cache and explicit-refresh throttle; mutation consumers bypass it. */
export async function readModelOwnerCached(options:{refresh?:boolean}={}):Promise<CachedModelOwner>{
 const now=Date.now();
 let refreshThrottled=false;
 const expired=!snapshot||now-snapshot.updatedAt>=CACHE_MS;
 let refresh=expired&&now>=nextCachedReadAt;
 if(options.refresh){
  if(now-lastExplicitRefreshAt<REFRESH_MS){refreshThrottled=true;refresh=false;}
  else{lastExplicitRefreshAt=now;refresh=true;}
 }
 if(refresh){nextCachedReadAt=now+CACHE_MS;await refreshModelOwner();}
 else if(flight&&!snapshot)try{await boundedRead(flight);}catch{/* A cold shared failure stays unknown. */}
 const value=peekModelOwner();
 return {snapshot:value,state:value?(!value.stale&&Date.now()-value.updatedAt<CACHE_MS?'fresh':'stale'):'unknown',refreshThrottled};
}

function boundedRead<T>(read:Promise<T>):Promise<T>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('model_owner_read_deadline')),5500);
  read.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
 });
}
