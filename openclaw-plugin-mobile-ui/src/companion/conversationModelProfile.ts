/** Settings of the existing conversation metadata owner, stored in the native SessionEntry only. */
import {createHash} from "crypto";
import {loadInstalledSessionStoreSdk,readInstalledModelProfileContractVersion} from "./ownerTurnGateway";
import {configuredModelFlow,CONTACT_MODEL_AGENTS,verifiedModelFlowProvenance} from "./modelOwner";
import {publicModelRef} from "./accountIdentity";
import {contactRoomSession} from "../contactRoomProfile";
import {readModelFlowConfigurationActivity} from "./runs";

export const MODEL_PROFILE_NAMESPACE="samantha-model-profile-v1";
const PLUGIN="openclaw-plugin-mobile-ui",MAX_SESSIONS=2000,MAX_BYTES=16384;
const levels=["off","minimal","low","medium","high","xhigh","adaptive","max","ultra"];
const closedText=(v:any,max:number)=>typeof v==="string"&&v.length>0&&v.length<=max&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(v);
const ref=(v:any)=>closedText(v,512)&&/^[A-Za-z0-9._+-]+\/.+/.test(v);
const hash=(v:any)=>createHash("sha256").update(JSON.stringify(v)??"undefined").digest("hex");
const refusal=()=>Object.assign(new Error("model_flow_profile_unavailable"),{statusCode:409});
export type ModelFlow="brain"|"whatsapp"|"conversation_summary";
type Selection={model:{primary:string;fallbacks:string[]};thinkingDefault:string|null;fastModeDefault:boolean|"auto"|null};
type SessionProfile={version:1;sessionId:string;flow?:"brain"|"whatsapp";selection?:Selection;summaryModel:string|null};
type Sdk={modelProfileContractVersion:number;getRuntimeConfig():any;getSessionEntry(p:any):any;listSessionEntries(p:any):any[];patchSessionEntry(p:any):Promise<any>};
let sdkPromise:Promise<Sdk>|undefined;
let sdkLoader:()=>Promise<Sdk>=loadInstalledSessionStoreSdk;
/** Tests replace the installed SDK, never the profile policy or a production storage path. */
export function setConversationModelProfileSdkForTests(load:()=>Promise<Sdk>){sdkLoader=load;sdkPromise=undefined;}
const sdk=()=>sdkPromise??=(sdkLoader().catch(e=>{sdkPromise=undefined;throw e;}));
/** #126: inside the Gateway the host hands the plugin its own session store and runtime config (api.runtime).
 * Using them imports no host module, so OpenClaw copies nothing into the plugin capture (21 045 files, 190 MB at
 * each restart on the S24 with the installed SDK import) and no second instance of any module exists. Same
 * functions and parameters as the installed SDK surface. The Companion process has no api: it keeps the loader. */
let contractReader:()=>Promise<number>=()=>readInstalledModelProfileContractVersion();
/** Tests replace the installed contract chunk reader, never the profile policy. */
export function setModelProfileContractReaderForTests(read:()=>Promise<number>){contractReader=read;}
export function hostSessionStoreSdk(api:any,contractVersion:()=>Promise<number>=()=>contractReader()):(()=>Promise<Sdk>)|undefined{
 const session=api?.runtime?.agent?.session,config=api?.runtime?.config;
 if(!session||!config||typeof config.current!=="function"||
    ["getSessionEntry","listSessionEntries","patchSessionEntry"].some(name=>typeof session[name]!=="function"))return undefined;
 return async()=>({modelProfileContractVersion:await contractVersion(),getRuntimeConfig:()=>config.current(),
  getSessionEntry:(p:any)=>session.getSessionEntry(p),listSessionEntries:(p:any)=>session.listSessionEntries(p),
  patchSessionEntry:(p:any)=>session.patchSessionEntry(p)});
}
function currentAgent(config:any,id:string){return config?.agents?.entries?.[id]??config?.agents?.list?.find((row:any)=>row.id===id)??{};}
function flowFor(agentId:string,key:string,config:any):"brain"|"whatsapp"|undefined {
 if(agentId==="main"){
  const wa=/^agent:main:whatsapp:direct:(\+?[1-9][0-9]{7,14})$/.exec(key);
  if(wa){const number=wa[1].startsWith("+")?wa[1]:"+"+wa[1];
   return (config?.commands?.ownerAllowFrom||[]).includes("whatsapp:"+number)?"whatsapp":undefined;}
  return key.startsWith("agent:main:")&&!key.includes(":whatsapp:")?"brain":undefined;
 }
 const room=contactRoomSession(key);
 return (CONTACT_MODEL_AGENTS as readonly string[]).includes(agentId)&&room?.agent===agentId?"whatsapp":undefined;
}
function selection(config:any,agentId:string,flow:"brain"|"whatsapp"):Selection {
 const brain=configuredModelFlow(config,"brain");let value:any=brain;
 if(flow==="whatsapp"){
  if(agentId==="main"){
   const own=config?.plugins?.entries?.[PLUGIN]?.config?.whatsappModelFlow;
   value=own?{model:own.model??brain.model,thinkingDefault:own.thinkingDefault??brain.thinkingDefault,fastModeDefault:own.fastModeDefault??brain.fastModeDefault}:brain;
  }else{const own=currentAgent(config,agentId);value={model:own.model??brain.model,thinkingDefault:own.thinkingDefault??brain.thinkingDefault,fastModeDefault:own.fastModeDefault??brain.fastModeDefault};}
 }
 const model=typeof value.model==="string"?{primary:value.model,fallbacks:[]}:value.model;
 if(!model||!ref(model.primary)||!Array.isArray(model.fallbacks??[])||(model.fallbacks??[]).length>20||(model.fallbacks??[]).some((v:any)=>!ref(v)))throw refusal();
 const thinking=value.thinkingDefault??null,fast=value.fastModeDefault??null;
 if(thinking!==null&&!levels.includes(thinking)||fast!==null&&typeof fast!=="boolean"&&fast!=="auto")throw refusal();
 return {model:{primary:model.primary,fallbacks:[...(model.fallbacks??[])]},thinkingDefault:thinking,fastModeDefault:fast};
}
function profileFor(entry:any,key:string,agentId:string,config:any):SessionProfile {
 if(!closedText(entry?.sessionId,128))throw refusal();
 const flow=flowFor(agentId,key,config),summary=config?.agents?.defaults?.compaction?.model??null;
 if(summary!==null&&!ref(summary))throw refusal();
 return {version:1,sessionId:entry.sessionId,...(flow?{flow,selection:selection(config,agentId,flow)}:{}),summaryModel:summary};
}
function readProfile(entry:any):SessionProfile|undefined {
 const v=entry?.pluginExtensions?.[PLUGIN]?.[MODEL_PROFILE_NAMESPACE];
 if(v===undefined)return undefined;
 // A reset creates a new canonical session id; old-generation extension data is never inherited.
 if(v?.sessionId!==entry.sessionId)return undefined;
 if(v.version!==1||!Object.prototype.hasOwnProperty.call(v,"summaryModel")||v.summaryModel!==null&&!ref(v.summaryModel)||Buffer.byteLength(JSON.stringify(v))>MAX_BYTES)throw refusal();
 if(v.selection){
  const s=v.selection;if(!["brain","whatsapp"].includes(v.flow)||!ref(s?.model?.primary)||!Array.isArray(s.model.fallbacks)||s.model.fallbacks.length>20||s.model.fallbacks.some((x:any)=>!ref(x))||s.thinkingDefault!==null&&!levels.includes(s.thinkingDefault)||s.fastModeDefault!==null&&typeof s.fastModeDefault!=="boolean"&&s.fastModeDefault!=="auto")throw refusal();
 }
 return v;
}
async function pin(owner:Sdk,agentId:string,key:string,entry:any,value:SessionProfile,budgetMs=5000):Promise<SessionProfile>{
 if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)throw refusal();
 let chosen:SessionProfile|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const work=owner.patchSessionEntry({agentId,sessionKey:key,preserveActivity:true,skipMaintenance:true,requireWriteSuccess:true,
  update:(fresh:any)=>{
   if(fresh.sessionId!==entry.sessionId||fresh.lifecycleRevision!==entry.lifecycleRevision)throw refusal();
   const prior=readProfile(fresh);if(prior){chosen=prior;return null;}
   chosen=value;
   return {pluginExtensions:{...fresh.pluginExtensions,[PLUGIN]:{...fresh.pluginExtensions?.[PLUGIN],[MODEL_PROFILE_NAMESPACE]:value}}};
  }});
 let saved:any;
 try{saved=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(refusal()),Math.max(1,budgetMs));})]);}
 finally{if(timer)clearTimeout(timer);}
 const observed=owner.getSessionEntry({agentId,sessionKey:key,readConsistency:"latest"});
 if(observed?.sessionId!==entry.sessionId||!chosen||hash(readProfile(observed))!==hash(chosen))throw refusal();
 // SDK may return null for an already-current row; the fresh canonical read above is the proof.
 void saved;return chosen;
}
/** Called from R6 only after its existing operation record was durably reserved. */
export async function preserveConversationModelProfiles(flow:ModelFlow,beforeConfig:any,operationId:string):Promise<{state:"verified";preserved:number}>{
 let owner:Sdk;try{owner=await sdk();}catch{throw Object.assign(new Error("model_flow_preservation_unqualified"),{statusCode:409});}if(owner.modelProfileContractVersion!==1)throw refusal();
 const operation="agent-operation-"+createHash("sha256").update(operationId).digest("hex");
 const activities=await readModelFlowConfigurationActivity();
 if(!activities.some(row=>row.operationId===operation&&row.flow===flow))throw refusal();
 const ids=flow==="conversation_summary"?[...new Set(["main",...Object.keys(beforeConfig?.agents?.entries||{}),...(beforeConfig?.agents?.list||[]).map((v:any)=>v.id)])]:["main",...CONTACT_MODEL_AGENTS];
 if(ids.length>100||ids.some(id=>!closedText(id,64)))throw refusal();
 const deadline=Date.now()+25000;
 const planned:{agentId:string;key:string;entry:any;profile:SessionProfile}[]=[];
 for(const agentId of ids){
  if(Date.now()>=deadline)throw refusal();
  const rows=owner.listSessionEntries({agentId,readOnly:true});if(!Array.isArray(rows)||rows.length>MAX_SESSIONS)throw refusal();
  for(const row of rows){
   if(!closedText(row?.sessionKey,512)||!row.sessionKey.startsWith("agent:"+agentId+":"))throw refusal();
   if(readProfile(row.entry))continue;
   if(flow!=="conversation_summary"&&!flowFor(agentId,row.sessionKey,beforeConfig))continue;
   planned.push({agentId,key:row.sessionKey,entry:row.entry,profile:profileFor(row.entry,row.sessionKey,agentId,beforeConfig)});
  }
 }
 if(planned.length>MAX_SESSIONS)throw refusal();
 let preserved=0;
 for(const p of planned){if(Date.now()>=deadline)throw refusal();await pin(owner,p.agentId,p.key,p.entry,p.profile,Math.min(5000,deadline-Date.now()));preserved++;}
 return {state:"verified",preserved};
}
function parseModel(reference:string){const slash=reference.indexOf("/"),at=reference.indexOf("@",slash);return {provider:reference.slice(0,slash),model:reference.slice(slash+1,at<0?undefined:at),profile:at<0?undefined:reference.slice(at+1)};}
function hasConfiguredProfile(config:any,flow:"brain"|"whatsapp"|undefined,summaryOnly=false){
 // A version label is not an admitted R6 profile. Check the owned settings hash
 // for each applicable flow; an unrelated WhatsApp profile cannot activate main.
 const summary=verifiedModelFlowProvenance(config,"conversation_summary");
 if(summaryOnly)return summary;
 const own=flow?verifiedModelFlowProvenance(config,flow):false;
 const inheritedBrain=flow==="whatsapp"?verifiedModelFlowProvenance(config,"brain"):false;
 return own||inheritedBrain||summary;
}
function validIdentity(ctx:any){return closedText(ctx?.agentId,64)&&closedText(ctx?.sessionKey,512)&&ctx.sessionKey.startsWith("agent:"+ctx.agentId+":")&&closedText(ctx.sessionId,128);}
/** Uses only native session metadata and the existing SDK per-run context. Neither is an execution authority. */
export function conversationModelProfileHooks(api:any){
 const contextApi=api.runContext||api,contextKey=MODEL_PROFILE_NAMESPACE;
 const host=hostSessionStoreSdk(api);let hostPromise:Promise<Sdk>|undefined;
 const sessionOwner=()=>host?(hostPromise??=host().catch(e=>{hostPromise=undefined;throw e;})):sdk();
 const getContext=(ctx:any)=>contextApi.getRunContext?.({runId:ctx.runId,namespace:contextKey});
 const setContext=(ctx:any,value:any)=>contextApi.setRunContext?.({runId:ctx.runId,namespace:contextKey,value});
 const matchingContext=(ctx:any,profile:SessionProfile)=>{
  const prior=getContext(ctx);return prior?.version===1&&prior.runId===ctx.runId&&prior.sessionId===ctx.sessionId&&prior.sessionKey===ctx.sessionKey&&prior.routingPrepared&&hash(prior.profile)===hash(profile)?prior:undefined;
 };
 const observeNeutral=(event:any,ctx:any,entry:any,config:any,owner:Sdk,allowCreate:boolean)=>{
  if(owner.modelProfileContractVersion!==1||event.modelProfileVersion!==1||!closedText(ctx.runId,160))return false;
  try{
   const profile=profileFor(entry,ctx.sessionKey,ctx.agentId,config),prior=matchingContext(ctx,profile);
   if(event.modelProfileStage==="before_candidates"&&allowCreate)return setContext(ctx,{version:1,runId:ctx.runId,sessionId:ctx.sessionId,sessionKey:ctx.sessionKey,profile,routingPrepared:true})===true;
   if(!prior)return false;
   if(["before_runtime","candidate"].includes(event.modelProfileStage))return setContext(ctx,{...prior,...(event.modelProfileStage==="candidate"?{candidatePrepared:true}:{runtimePrepared:true})})===true;
   return event.modelProfileStage==="before_candidates";
  }catch{return false;}
 };
 return {
  extension:{namespace:MODEL_PROFILE_NAMESPACE,description:"Frozen model settings of this canonical conversation; no execution authority.",project:(ctx:any)=>{
   const v=readProfile({sessionId:ctx.sessionId,pluginExtensions:{[PLUGIN]:{[MODEL_PROFILE_NAMESPACE]:ctx.state}}});
   return v?{version:1,flow:v.flow??null,model:v.selection?publicModelRef(v.selection.model.primary):null,summaryModel:publicModelRef(v.summaryModel),thinkingDefault:v.selection?.thinkingDefault??null,fastModeDefault:v.selection?.fastModeDefault??null}:undefined;
  }},
  async resolve(event:any,ctx:any){
   if(event?.modelProfileStage!=="summary"&&!["main",...CONTACT_MODEL_AGENTS].includes(ctx?.agentId))return undefined;
   try{
    if(!validIdentity(ctx))return {modelSelectionRefused:"session_identity_unavailable"};
    const owner=await sessionOwner(),config=owner.getRuntimeConfig(),flow=flowFor(ctx.agentId,ctx.sessionKey,config);
    if(!flow&&event.modelProfileStage!=="summary")return undefined;
    const entry=owner.getSessionEntry({agentId:ctx.agentId,sessionKey:ctx.sessionKey,readConsistency:"latest"});
    if(entry?.sessionId!==ctx.sessionId)return {modelSelectionRefused:"session_identity_changed"};
    let frozen=readProfile(entry);
    if(!frozen){
     // The first R6 change must fence newly-created sessions too, before its
     // config provenance exists. A pre-existing row is captured by R6's list;
     // a later row sees this durable reservation and cannot start unpinned.
     if((await readModelFlowConfigurationActivity()).length){
      if(observeNeutral(event,ctx,entry,config,owner,false))return undefined;
      return {modelSelectionRefused:"configuration_in_progress"};
     }
     if(!hasConfiguredProfile(config,flow,event.modelProfileStage==="summary")){
      // Keep the legacy selection neutral. The attested native prefix can
      // observe this run's original settings without pinning or overriding
      // them. If R6 freezes the same session mid-run, only an exact match to
      // that earlier observation may continue; no preparation is invented.
      observeNeutral(event,ctx,entry,config,owner,true);
      return undefined;
     }
    }
    if(owner.modelProfileContractVersion!==1||event.modelProfileVersion!==1||!["before_candidates","before_runtime","candidate","summary"].includes(event.modelProfileStage))return {modelSelectionRefused:"model_profile_contract_unavailable"};
    if(!frozen)frozen=await pin(owner,ctx.agentId,ctx.sessionKey,entry,profileFor(entry,ctx.sessionKey,ctx.agentId,config));
    if(event.modelProfileStage==="summary")return {summaryModelOverride:frozen.summaryModel};
    if(!frozen.selection||frozen.flow!==flow)return {modelSelectionRefused:"model_profile_scope_changed"};
    const s=frozen.selection,explicitModel=["user","default"].includes(entry.modelOverrideSource)||entry.modelSelectionLocked===true;
    const primary=parseModel(s.model.primary),current={provider:ctx.modelProviderId,model:ctx.modelId};
    if(event.modelProfileStage==="before_candidates"){
     if(!closedText(ctx.runId,160)||setContext(ctx,{version:1,runId:ctx.runId,sessionId:ctx.sessionId,sessionKey:ctx.sessionKey,profile:frozen,routingPrepared:true})!==true)return {modelSelectionRefused:"run_context_unavailable"};
     const pinnedAccount=["user","user-link"].includes(entry.authProfileOverrideSource)?entry.authProfileOverride:undefined;
     return {...(!explicitModel?{providerOverride:primary.provider,modelOverride:primary.model,modelFallbacksOverride:s.model.fallbacks,authProfileId:pinnedAccount??primary.profile??null,authProfileIdSource:pinnedAccount||primary.profile?"user":null}:{}),summaryModelOverride:frozen.summaryModel};
    }
    const prepared=getContext(ctx);
    if(prepared?.version!==1||prepared.runId!==ctx.runId||prepared.sessionId!==ctx.sessionId||prepared.sessionKey!==ctx.sessionKey||!prepared.routingPrepared||hash(prepared.profile)!==hash(frozen))return {modelSelectionRefused:"model_profile_route_unprepared"};
    const candidate=[s.model.primary,...s.model.fallbacks].map(parseModel).find(v=>v.provider===current.provider&&v.model===current.model);
    const userAccount=["user","user-link"].includes(entry.authProfileOverrideSource)&&closedText(entry.authProfileOverride,512)?entry.authProfileOverride:undefined;
    const account=userAccount??candidate?.profile??(candidate?.provider===primary.provider?primary.profile:undefined);
    const fields={providerOverride:current.provider,modelOverride:current.model,...(!explicitModel||userAccount?{authProfileId:account??null,authProfileIdSource:account?"user":null}:{}),
     ...(!explicitModel?{modelFallbacksOverride:s.model.fallbacks}:{}),
     thinkLevel:entry.thinkingLevel??s.thinkingDefault,fastMode:entry.fastMode??s.fastModeDefault,summaryModelOverride:frozen.summaryModel};
    if(setContext(ctx,{...prepared,...(event.modelProfileStage==="candidate"?{candidatePrepared:true}:{runtimePrepared:true})})!==true)return {modelSelectionRefused:"run_context_unavailable"};
    return fields;
   }catch{return {modelSelectionRefused:"model_profile_unavailable"};}
  },
  async admit(_event:any,ctx:any){
   if(!["main",...CONTACT_MODEL_AGENTS].includes(ctx?.agentId))return undefined;
   try{const owner=await sessionOwner(),config=owner.getRuntimeConfig(),flow=flowFor(ctx?.agentId,ctx?.sessionKey,config);if(!flow)return undefined;
    const entry=owner.getSessionEntry({agentId:ctx.agentId,sessionKey:ctx.sessionKey,readConsistency:"latest"});
    if(entry?.sessionId!==ctx.sessionId)throw refusal();
    const frozen=readProfile(entry);
    if(!frozen){
     if((await readModelFlowConfigurationActivity()).length&&!matchingContext(ctx,profileFor(entry,ctx.sessionKey,ctx.agentId,config))?.candidatePrepared)throw refusal();
     if(!hasConfiguredProfile(config,flow))return undefined;
    }
    if(owner.modelProfileContractVersion!==1)throw refusal();
    const proof=validIdentity(ctx)&&getContext(ctx);
    return proof?.version===1&&proof.runId===ctx.runId&&proof.sessionId===ctx.sessionId&&proof.sessionKey===ctx.sessionKey&&proof.candidatePrepared&&frozen&&hash(proof.profile)===hash(frozen)?{outcome:"pass"}:
     {outcome:"block",reason:"model_profile_consumer_unverified",category:"configuration",message:"Les réglages de cette conversation ne sont pas encore prêts. Aucune demande n’a été exécutée."};
   }catch{return {outcome:"block",reason:"model_profile_owner_unavailable",category:"configuration",message:"Les réglages de cette conversation restent à vérifier."};}
  }
 };
}
