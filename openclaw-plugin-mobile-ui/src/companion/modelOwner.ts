import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {accountAlias,publicModelRef,ACCOUNT_ALIAS} from "./accountIdentity";
import {callOpenClawGateway} from "./openclawAgentClient";

// Process-local projection of the existing Gateway owners. No credential or
// whole config/auth object is retained; fresh mutation reads keep their own
// validation, CAS and dispatch rules in the consumer.
export type ModelOwnerRead={raw:any,catalog:any,auth:any,policy?:any};
export type ModelOwnerSnapshot={config:any,catalog:any,auth:any,revision:string|null,updatedAt:number,stale?:boolean,policy?:any};
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
const providerRef=(value:any)=>identity(value)&&/^[a-z][a-z0-9_.-]{0,79}$/.test(value)?value:undefined;
function agent(value:any){
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 return {model:model(value.model),thinkingDefault:text(value.thinkingDefault,40),...(typeof value.fastModeDefault==='boolean'?{fastModeDefault:value.fastModeDefault}:{}),tools:tools(value.tools),
  modelPolicy:value.modelPolicy&&Object.prototype.hasOwnProperty.call(value.modelPolicy,'allow')?{allow:strings(value.modelPolicy.allow,2000,200)?.filter(x=>identity(x)||/^[a-z][a-z0-9_.-]{0,79}\/\*$/.test(x!))}:undefined,compaction:{model:model(value.compaction?.model)}};
}
/** Same explicit-agent then default allow precedence as OpenClaw resolveConfiguredModelPolicyAllow.
 * An explicit empty agent allow remains empty; no policy is widened or persisted. */
export function configuredModelAllow(config:any,agentId='main'):string[]{
 const entry=config?.agents?.entries?.[agentId]??config?.agents?.list?.find((row:any)=>row.id===agentId);
 const ownsAllow=entry?.modelPolicy&&Object.prototype.hasOwnProperty.call(entry.modelPolicy,'allow');
 const selected=ownsAllow?entry.modelPolicy.allow:config?.agents?.defaults?.modelPolicy?.allow;
 return Array.isArray(selected)&&selected.length<=2000?selected.filter((ref:any)=>identity(ref)||typeof ref==='string'&&/^[a-z][a-z0-9_.-]{0,79}\/\*$/.test(ref)) : [];
}
/** Configured policy supports its existing closed provider/* form, never an implicit global allow. */
export function modelReferenceAllowed(allow:string[],reference:string):boolean {
 const base=reference.split('@')[0];return allow.some(item=>item===base||/^[a-z][a-z0-9_.-]{0,79}\/\*$/.test(item)&&base.startsWith(item.slice(0,-1)));
}
export const MODEL_FLOW_IDS=['brain','web_search','conversation_summary','memory_search','realtime_voice','spoken_voice','dictation','voice_memos','immune_system','engineering_learning','whatsapp'] as const;
export type ModelFlowId=typeof MODEL_FLOW_IDS[number];
export const CONTACT_MODEL_AGENTS=['contacts','contacts-projet','contacts-pulse','contacts-projet-pulse'] as const;
export type EditableModelFlow='brain'|'conversation_summary'|'whatsapp';
export const MODEL_FLOW_PROVENANCE_PATH=['plugins','entries','openclaw-plugin-mobile-ui','config','modelFlowSelection'] as const;
const flowError=()=>Object.assign(new Error('model_flow_provenance_unverified'),{statusCode:409});
/** The R6-owned setting paths are also the source of its durable admission proof. */
export function modelFlowSettingPaths(flow:EditableModelFlow):string[][]{
 if(flow==='conversation_summary')return [['agents','defaults','compaction','model']];
 const agents=flow==='brain'?['main']:[...CONTACT_MODEL_AGENTS];
 return [...agents.flatMap(id=>['model','thinkingDefault','fastModeDefault'].map(field=>['agents','entries',id,field])),
  ...(flow==='whatsapp'?[['plugins','entries','openclaw-plugin-mobile-ui','config','whatsappModelFlow']]:[])];
}
export function modelFlowSafeValue(value:any,depth=0):any{
 if(depth>12)throw flowError();
 if(typeof value==='string'){if(!identity(value))throw flowError();return value.includes('/')?publicModelRef(value):value;}
 if(typeof value==='boolean')return value;
 if(Array.isArray(value)&&value.length<=20)return value.map(row=>modelFlowSafeValue(row,depth+1));
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  if(Object.keys(value).sort().join()==='fieldsHash,version'){
   if(value.version!==1||typeof value.fieldsHash!=='string'||!/^[a-f0-9]{64}$/.test(value.fieldsHash))throw flowError();
   return {version:1,fieldsHash:value.fieldsHash};
  }
  if(Object.keys(value).every(key=>['version','model','primary','fallbacks','thinkingDefault','fastModeDefault'].includes(key)))
   return Object.fromEntries(['version','model','primary','fallbacks','thinkingDefault','fastModeDefault'].filter(key=>key in value).map(key=>[key,key==='version'&&value[key]===1?1:modelFlowSafeValue(value[key],depth+1)]));
 }
 throw flowError();
}
export function modelFlowSettingSnapshot(config:any,flow:EditableModelFlow){
 return modelFlowSettingPaths(flow).map(path=>{
  let node=config;for(const key of path){if(!node||typeof node!=='object'||!Object.prototype.hasOwnProperty.call(node,key))return {path,present:false};node=node[key];}
  return {path,present:true,value:modelFlowSafeValue(node)};
 });
}
export function modelFlowSettingHash(config:any,flow:EditableModelFlow):string{return crypto.createHash('sha256').update(JSON.stringify(modelFlowSettingSnapshot(config,flow))).digest('hex');}
/** Reads only R6 metadata in the canonical config. Absence is neutral; malformed proof fails closed. */
export function verifiedModelFlowProvenance(config:any,flow:EditableModelFlow):boolean{
 const value=config?.plugins?.entries?.['openclaw-plugin-mobile-ui']?.config?.modelFlowSelection;
 if(value===undefined)return false;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||Object.keys(value).sort().join()!=='flows,version'||!value.flows||typeof value.flows!=='object'||Array.isArray(value.flows)||Object.keys(value.flows).some(id=>!['brain','conversation_summary','whatsapp'].includes(id)))throw flowError();
 for(const entry of Object.values(value.flows))modelFlowSafeValue(entry);
 const proof=value.flows[flow];if(proof===undefined)return false;
 if(proof.fieldsHash!==modelFlowSettingHash(config,flow))throw flowError();
 return true;
}
/** A bounded read of the canonical policy, inside the existing model owner, not a new registry or cache. */
export function readIncludedModelPolicy(){
 try{
  const pinned=path.join(os.homedir(),'.openclaw/runtime-ui-playbooks/current');
  const root=process.env.SAMANTHA_CONTROL_PLAYBOOKS||process.env.CLAW_UI_PLAYBOOKS_ROOT||pinned;
  const file=path.join(root,'skill_intelligence/model_policy.json');
  const metadata=fs.statSync(file);if(!metadata.isFile()||metadata.size>65536)return null;
  const bytes=fs.readFileSync(file),value=JSON.parse(bytes.toString());
  if(!value||value.authentication!=='subscription_only'||!value.model_slots||typeof value.model_slots!=='object'||Array.isArray(value.model_slots)||Object.keys(value.model_slots).length>64)return null;
  const slots=Object.fromEntries(Object.entries(value.model_slots).flatMap(([key,row]:[string,any])=>{
   if(!/^[a-z_]{1,64}$/.test(key)||typeof row?.enabled!=='boolean')return [];
   return [[key,{enabled:row.enabled,provider:providerRef(row.provider),model:model(row.model),cost_policy:['free_only','subscription'].includes(row.cost_policy)?row.cost_policy:null,executor:text(row.executor,64),qualification_ref:text(row.qualification_ref,240)}]];
  }));
  return {authentication:value.authentication,primary:model(value.primary),fallback:model(value.fallback),model_slots:slots,sourceHash:crypto.createHash('sha256').update(bytes).digest('hex')};
 }catch{return null;}
}
export function configuredModelFlow(config:any,flow:'brain'|'conversation_summary'|'whatsapp'){
 const entry=(id:string)=>config?.agents?.entries?.[id]??config?.agents?.list?.find((row:any)=>row.id===id);
 const defaults=config?.agents?.defaults||{},main=entry('main')||{},base={model:main.model??defaults.model,thinkingDefault:main.thinkingDefault??defaults.thinkingDefault,fastModeDefault:main.fastModeDefault??defaults.fastModeDefault};
 if(flow==='brain')return {...base,inheritsFrom:main.model===undefined?'default':null,explicit:main,origins:{model:main.model===undefined?'default':'flow',thinking:main.thinkingDefault===undefined?'default':'flow',fastMode:main.fastModeDefault===undefined?'default':'flow'},mixedFields:[]};
 if(flow==='conversation_summary'){const own=defaults.compaction||{};return {model:own.model??null,thinkingDefault:null,fastModeDefault:null,inheritsFrom:own.model===undefined?'conversation':null,explicit:own,origins:{model:own.model===undefined?'conversation':'flow',thinking:'unsupported',fastMode:'unsupported'},mixedFields:[]};}
 const own=config?.plugins?.entries?.['openclaw-plugin-mobile-ui']?.config?.whatsappModelFlow||{},contacts=CONTACT_MODEL_AGENTS.map(id=>entry(id)||{}),origins:any={},selected:any={},mixedFields:string[]=[];
 for(const [field,publicField] of [['model','model'],['thinkingDefault','thinking'],['fastModeDefault','fastMode']]){
  if(own[field]!==undefined){selected[field]=own[field];origins[publicField]='flow';continue;}
  const values=contacts.map(row=>row[field]),present=values.filter(value=>value!==undefined);
  if(present.length===contacts.length&&new Set(values.map(value=>JSON.stringify(value))).size===1){selected[field]=values[0];origins[publicField]='whatsapp_agents';if(JSON.stringify(values[0])!==JSON.stringify((base as any)[field]))mixedFields.push(publicField);}
  else {selected[field]=(base as any)[field];origins[publicField]='brain';if(present.length)mixedFields.push(publicField);}
 }
 return {...selected,inheritsFrom:Object.values(origins).every(value=>value==='brain')?'brain':null,explicit:own,origins,mixedFields};
}
/** Billing admission needs policy AND a matching authenticated account, never just models.list.available. */
export function includedModelAccounts(reference:string,auth:any,policy:any):{reference:string;account:string;costPolicy:string;source:string}[]{
 if(!policy||policy.authentication!=='subscription_only')return [];
 const base=reference.split('@')[0],provider=base.split('/')[0];
 const row=auth?.providers?.find((item:any)=>item.provider===provider);
 if(!row||!['ok','static','expiring'].includes(row.status))return [];
 const slots=Object.values(policy.model_slots||{}) as any[];
 return (Array.isArray(row.profiles)&&row.profiles.length<=64?row.profiles:[]).flatMap((profile:any)=>{
  const id=typeof profile.profileId==='string'?profile.profileId:null;
  if(!id||!/^[A-Za-z0-9._:+@-]{1,200}$/.test(id)||!['ok','static','expiring'].includes(profile.status))return [];
  const pinned=base+'@'+id;
  // ChatGPT OAuth cannot select an API-key profile. The canonical subscription policy attests its executor.
  const subscription=provider==='openai'&&profile.type==='oauth'&&slots.some(slot=>slot.enabled===true&&slot.provider==='openai'&&slot.cost_policy==='subscription'&&slot.executor==='native_agent_exec'&&slot.qualification_ref);
  // API-key profiles are admitted only as the exact canonical free-only model/profile pair.
  const free=slots.some(slot=>slot.enabled===true&&slot.cost_policy==='free_only'&&publicModelRef(slot.model)===publicModelRef(pinned)&&slot.qualification_ref);
  if(!subscription&&!free)return [];
  return [{reference:pinned,account:ACCOUNT_ALIAS.test(id)?id:accountAlias(id),costPolicy:subscription?'subscription':'free_only',source:'canonical_model_policy_and_auth'}];
 });
}
function publicFlowProvenance(value:any){
 try{
  if(!value||value.version!==1||Object.keys(value).sort().join()!=='flows,version'||!value.flows||typeof value.flows!=='object'||Array.isArray(value.flows)||Object.keys(value.flows).some(key=>!['brain','conversation_summary','whatsapp'].includes(key)))return {version:0,flows:{}};
  return {version:1,flows:Object.fromEntries(Object.entries(value.flows).map(([key,proof])=>[key,modelFlowSafeValue(proof)]))};
 }catch{return {version:0,flows:{}};}
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
  return [{provider,status,...(publicName(row.displayName)?{displayName:publicName(row.displayName)}:{}),...(Array.isArray(row.profiles)&&row.profiles.length<=2000?{profiles:row.profiles.flatMap((profile:any)=>{const rawId=typeof profile?.profileId==='string'&&profile.profileId.length<=200?profile.profileId:undefined,status=authState(profile?.status);return rawId&&status?[{profileId:accountAlias(rawId),status,...(['oauth','api_key','token'].includes(profile.type)?{type:profile.type}:{})}]:[];})}:{})}];
 });
 const rawPlugin=config.plugins?.entries?.['openclaw-plugin-mobile-ui']?.config,pluginSettings={...(rawPlugin?.whatsappModelFlow?{whatsappModelFlow:agent(rawPlugin.whatsappModelFlow)}:{}),...(rawPlugin?.modelFlowSelection!==undefined?{modelFlowSelection:publicFlowProvenance(rawPlugin.modelFlowSelection)}:{})};
 return {config:{agents:{entries:Object.fromEntries(["main","engineering-lite","gemini",...CONTACT_MODEL_AGENTS].flatMap(id=>config.agents?.entries?.[id]?[[id,agent(config.agents.entries[id])]]:[])),defaults:agent(config.agents?.defaults),...(Array.isArray(config.agents?.list)&&config.agents.list.length<=100?{list:config.agents.list.filter((row:any)=>['main',...CONTACT_MODEL_AGENTS].includes(row?.id)).slice(0,5).map((row:any)=>({id:row.id,...agent(row)}))}:{})},plugins:{entries:{...plugins,...(plugins['openclaw-plugin-mobile-ui']&&Object.keys(pluginSettings).length?{'openclaw-plugin-mobile-ui':{...plugins['openclaw-plugin-mobile-ui'],config:pluginSettings}}:{})}},tools:tools(config.tools),talk:{provider:providerRef(config.talk?.provider),providers:providerRef(config.talk?.provider)?{[config.talk.provider]:{voice:identity(config.talk?.providers?.[config.talk.provider]?.voice)}}:{},realtime:{provider:providerRef(config.talk?.realtime?.provider),model:config.talk?.realtime?.model==null?null:identity(config.talk.realtime.model)??false}},memory:{search:{provider:providerRef(config.memory?.search?.provider),model:config.memory?.search?.model==null?null:identity(config.memory.search.model)??false}}},catalog:{models,providerOutcomes:Array.isArray(value.catalog.providerOutcomes)&&value.catalog.providerOutcomes.length<=2000?value.catalog.providerOutcomes.flatMap((row:any)=>typeof row?.provider==='string'&&/^[A-Za-z0-9._+-]{1,200}$/.test(row.provider)&&['ready','needs_auth','unknown'].includes(row.status)?[{provider:row.provider,status:row.status}]:[]):[]},auth:{providers},revision:text(value.raw.hash)||null,updatedAt:Date.now(),policy:value.policy??null};
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
  const value={raw,catalog,auth,policy:readIncludedModelPolicy()},next=projected(value);
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

/** Observe only a verified config readback using the already-read catalog/auth owners. */
export function observeVerifiedModelOwnerConfig(value:ModelOwnerRead):void{const next=projected(value);if(next){snapshot=next;lastReadFailed=false;}}
