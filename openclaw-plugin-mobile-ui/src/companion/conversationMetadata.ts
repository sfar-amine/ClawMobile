import {conversationContext} from "./conversationContext";
import {observeConversationOwnerRow,observeSessionDefaults,readConversationOwnerRow} from "./conversationOwnerIndex";
import {readModelOwnerFresh,peekModelOwner,readModelOwnerCached} from "./modelOwner";
import {accountAlias,accountView,knownProfiles,publicModelRef,resolveModelRef} from "./accountIdentity";
import {createHash} from "crypto";
import {callOpenClawGateway,expectedCompanionSessionKey} from "./openclawAgentClient";
import {readPaymentRequests,readOwnerConfirmations,reserveSubmittedRun,settleSubmittedRun,retainedConversation} from "./runs";
import {nativeError,existingNativeOperation,storedNativeOperationResult} from "./nativeOperation";

const thinkingId=(value:any):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(value);
function thinking(row:any){
 const source=Array.isArray(row?.thinkingOptions)?row.thinkingOptions:Array.isArray(row?.thinkingLevels)?row.thinkingLevels.map((x:any)=>x?.id):[];
 const levels=[...new Set<string>(source.filter(thinkingId))].slice(0,32);
 const override=levels.includes(row?.thinkingLevel)?row.thinkingLevel:null;
 const fallback=levels.includes(row?.thinkingDefault)?row.thinkingDefault:null;
 return {thinkingLevel:override??fallback,thinkingLevelSource:override?'session':fallback?'default':null,thinkingLevels:levels};
}
const operationPattern=/^[-A-Za-z0-9_.:]{1,128}$/;
const modelPattern=/^[A-Za-z0-9._:+-]+\/[A-Za-z0-9._:/+@-]{1,160}$/;
const hiddenText=/[\p{C}\p{Zl}\p{Zp}]/u;
const readBudget={timeoutMs:10000,hardTimeoutMs:10000};
function session(id:string){if(!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)||id.length>80)throw nativeError('invalid_session_id');return expectedCompanionSessionKey(id);}
async function ownerRow(id:string){
 const key=session(id),value=await callOpenClawGateway('sessions.list',{search:key,limit:20},readBudget);
 if(!Array.isArray(value?.sessions)||value.sessions.length>20)throw nativeError('conversation_owner_unavailable',503);
 observeSessionDefaults(value.defaults);
 const matches=value.sessions.filter((row:any)=>row.key===key);
 if(matches.length!==1)throw nativeError(matches.length?'conversation_identity_ambiguous':'conversation_not_found',matches.length?409:404);
 observeConversationOwnerRow(matches[0]);
 return matches[0];
}
const ref=(provider:string,model:string)=>model.startsWith(provider+'/')?model:provider+'/'+model;
function projection(id:string,row:any){
 const title=typeof row.label==='string'&&row.label.length<=160&&!hiddenText.test(row.label)?row.label:null;
 const pinned=typeof row.pinned==='boolean'?row.pinned:null;
 const effective=typeof row.model==='string'&&typeof row.modelProvider==='string'?ref(row.modelProvider,row.model):null;
 const baseModel=typeof row.modelOverride==='string'&&typeof row.providerOverride==='string'?ref(row.providerOverride,row.modelOverride):effective;
 const profile=typeof row.authProfileOverride==='string'&&/^[A-Za-z0-9._:+-]{1,128}$/.test(row.authProfileOverride)?row.authProfileOverride:null;
 const model=baseModel&&profile&&!baseModel.includes('@')?baseModel+'@'+profile:baseModel;
 return {success:true,state:'ok',receipt:null,sessionId:id,...thinking(row),hasActiveRun:typeof row.hasActiveRun==='boolean'?row.hasActiveRun:null,thinkingChangeAvailable:row.hasActiveRun===false&&row.permissionModePending===false&&thinking(row).thinkingLevels.length>0,context:conversationContext(row),title,pinned,model:model&&modelPattern.test(model)?model:null,modelAuthProfile:profile,
  modelSource:['user','auto','inherited'].includes(row.modelOverrideSource)?row.modelOverrideSource:null,
  mutationAvailable:typeof row.sessionId==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(row.sessionId),
  issues:[...(!('authProfileOverride' in row)?['conversation_auth_profile_unknown']:[]),...(pinned===null?['conversation_pin_unknown']:[]),...(!model?['conversation_model_unknown']:[])]};
}
function modelCatalogFrom({raw:configRaw,catalog,auth}:any){
 const config=configRaw?.config,allow=config?.agents?.entries?.main?.modelPolicy?.allow;
 if(!Array.isArray(allow)||!Array.isArray(catalog?.models)||catalog.models.length>2000||auth?.unavailable||!Array.isArray(auth?.providers))throw nativeError('conversation_model_catalog_unavailable',503);
 const usable=(provider:string,profile?:string)=>{
  const row=auth.providers.find((x:any)=>x.provider===provider);
  return row&&['ok','static','expiring'].includes(row.status)&&(!profile||row.profiles?.some((x:any)=>x.profileId===profile&&['ok','static','expiring'].includes(x.status)));
 };
 const models:string[]=[];
 for(const row of catalog.models){
  if(typeof row?.provider!=='string'||typeof row?.id!=='string')continue;
  const id=ref(row.provider,row.id),base=id.split('@')[0];
  if(!modelPattern.test(id)||!allow.includes(base)||row.available!==true||config.plugins?.entries?.[row.provider]?.enabled===false||!usable(row.provider))continue;
  models.push(id);
  for(const profile of auth.providers.find((x:any)=>x.provider===row.provider)?.profiles||[]){
   const explicit=base+'@'+profile.profileId;
   if(modelPattern.test(explicit)&&usable(row.provider,profile.profileId))models.push(explicit);
  }
 }
 return [...new Set(models)];
}
/** Same window as R21 providers: a successful owner snapshot stays usable 5 min while the shared refresh runs. */
const CATALOG_SERVE_MS=300000;
/** A conversation the Companion still lists but the Gateway no longer knows: readable, never mutable. */
function retainedOnly(id:string,retained:{lastActivityAt:number|null}){
 return {success:true,state:'degraded',receipt:null,sessionId:id,readOnly:true,thinkingLevel:null,thinkingLevelSource:null,thinkingLevels:[],hasActiveRun:null,
  thinkingChangeAvailable:false,context:null,title:null,pinned:null,model:null,modelAuthProfile:null,modelAccount:null,modelSource:null,mutationAvailable:false,
  models:[],modelChangeAvailable:false,lastActivityAt:retained.lastActivityAt,issues:['conversation_gateway_session_unavailable']};
}
/** App-facing projection: account profiles only as opaque `acct-…` handles. */
function publicMetadata(value:any){
 return {...value,model:publicModelRef(value.model),modelAuthProfile:value.modelAuthProfile?accountAlias(value.modelAuthProfile):null,modelAccount:accountView(value.model),
  models:Array.isArray(value.models)?value.models.map((ref:string)=>publicModelRef(ref)):value.models};
}
export async function readConversationMetadata(id:string){
 const owner=await readConversationOwnerRow(session(id));
 if(!owner.row){
  // 10/10 S24: 8 of 10 listed conversations had no Gateway session left (session_nodes, exact sessions.list).
  const retained=owner.notFound?await retainedConversation(id):null;
  if(retained)return retainedOnly(id,retained);
  throw nativeError(owner.notFound?'conversation_not_found':'conversation_owner_unavailable',owner.notFound?404:503);
 }
 const value=projection(id,owner.row),cached=peekModelOwner();
 const age=cached?Date.now()-cached.updatedAt:Infinity;
 // Never leave the composer on an aging snapshot: start the shared single-flight refresh, do not wait for it.
 if(!cached||cached.stale||age>=60000)void readModelOwnerCached().catch(()=>{});
 let catalog:string[]|null=null;
 if(cached)try{catalog=modelCatalogFrom({raw:{config:cached.config},catalog:cached.catalog,auth:cached.auth});}catch{}
 // The snapshot itself is a successful read: a later failed refresh (`stale`) does not void it inside the window.
 const catalogFresh=!!cached&&age<CATALOG_SERVE_MS;
 return publicMetadata({...value,models:catalog||[],thinkingChangeAvailable:value.thinkingChangeAvailable&&owner.state!=='pending',modelChangeAvailable:owner.state!=='pending'&&catalogFresh&&catalog!==null&&catalog.length>0&&owner.row.hasActiveRun===false&&owner.row.permissionModePending===false,
  issues:[...value.issues,...(catalog===null?['conversation_model_catalog_unavailable']:!catalogFresh?['conversation_model_catalog_stale']:[]),
   ...(owner.state==='stale'?['conversation_owner_stale']:owner.state==='pending'?['conversation_owner_refresh_pending']:[]),...(!value.thinkingLevels.length?['conversation_thinking_profile_unknown']:[])]});
}
async function protectedActivity(){
 const [payments,confirmations]=await Promise.all([readPaymentRequests(),readOwnerConfirmations()]);
 return payments.some(row=>['awaiting_owner','executing','effect_unknown','requires_bank_action'].includes(row.state))||confirmations.some(row=>row.state==='awaiting_owner'&&row.expiresAt>Date.now());
}
function refusal(error:any):{code:string;status:number}|null{
 let payload=error?.error||error?.data?.error||error?.data||error;
 // The CLI can encode the canonical error object inside its diagnostic string.
 if(typeof payload?.message==='string'){
  const start=payload.message.indexOf('{'),end=payload.message.lastIndexOf('}');
  if(start>=0&&end>start)try{const value=JSON.parse(payload.message.slice(start,end+1));payload=value?.error||value?.data?.error||value?.data||value;}catch{}
 }
 const code=String(payload?.code||error?.code||'').toUpperCase();
 const text=String(payload?.message||payload?.details?.reason||error?.message||'');
 if(['ECONNREFUSED','ENOENT'].includes(code)||/\bECONNREFUSED\b/.test(text))return {code:'conversation_gateway_unreachable',status:503};
 if(['ETIMEDOUT','ECONNRESET','EPIPE'].includes(code)||/timed out|timeout|connection (closed|lost|reset)|ECONNRESET|ECONNREFUSED|socket hang up/i.test(text))return null;
 if(/thinking.*(unsupported|invalid|not supported)/i.test(text))return {code:'unsupported_thinking_level',status:400};
 if(/label.*(already|unique|used)|duplicate.*label/i.test(text))return {code:'conversation_label_already_used',status:409};
 if(/expectedSessionId|identity.*changed|session.*changed/i.test(text))return {code:'conversation_identity_changed',status:409};
 if(/catalog.*(loading|unavailable)|model.*catalog.*ready/i.test(text))return {code:'conversation_model_catalog_unavailable',status:503};
 if(/model.*(not allowed|not authorized|unknown|unsupported)|unknown.*model/i.test(text))return {code:'unknown_conversation_model',status:409};
 if(/busy|active run/i.test(text))return {code:'conversation_model_change_requires_idle',status:409};
 if(/archived/i.test(text))return {code:'conversation_archived',status:409};
 if(['INVALID_REQUEST','FORBIDDEN','CONFLICT','UNAVAILABLE'].includes(code)||/\b(INVALID_REQUEST|FORBIDDEN|CONFLICT|UNAVAILABLE)\b/.test(text))return {code:'conversation_gateway_refused',status:409};
 return null;
}
const pending=new Map<string,Promise<any>>();
export async function changeConversationMetadata(id:string,body:any){
 const op=String(body?.operationId||'');
 if(pending.has(op)){await pending.get(op);return changeConversationMetadata(id,body);}
 const work=changeOnce(id,body);pending.set(op,work);
 try{return await work;}finally{if(pending.get(op)===work)pending.delete(op);}
}
async function changeOnce(id:string,body:any){
 const key=session(id);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['operationId','title','pinned','model','thinkingLevel'].includes(k))||typeof body.operationId!=='string'||!operationPattern.test(body.operationId)||!['title','pinned','model','thinkingLevel'].some(k=>k in body)||
  ('title' in body&&(typeof body.title!=='string'||!body.title.trim()||body.title.length>120||hiddenText.test(body.title)))||
  ('pinned' in body&&typeof body.pinned!=='boolean')||('model' in body&&(typeof body.model!=='string'||!modelPattern.test(body.model))))throw nativeError('invalid_conversation_metadata');
 if('model' in body&&'thinkingLevel' in body)throw nativeError('conversation_settings_must_be_separate');
 if('thinkingLevel' in body&&!thinkingId(body.thinkingLevel))throw nativeError('unsupported_thinking_level');
 const desired={...('title' in body?{title:body.title.trim()}:{}),...('pinned' in body?{pinned:body.pinned}:{}),...('model' in body?{model:body.model}:{}),...('thinkingLevel' in body?{thinkingLevel:body.thinkingLevel}:{})};
 const action='conversation.metadata',target=createHash('sha256').update(JSON.stringify({sessionId:id,...desired})).digest('hex');
 const identity=JSON.stringify({action,target});
 const existing=await existingNativeOperation(body.operationId,identity);if(existing&&existing.state!=='failed')return existing;
 const row=await ownerRow(id);
 if(typeof row.sessionId!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(row.sessionId))throw nativeError('conversation_identity_unavailable',409);
 if(await protectedActivity())throw nativeError('protected_owner_activity',409);
 const targetThinking=thinking(row).thinkingLevels;
 let gatewayModel:string|undefined;
 if('thinkingLevel' in desired&&(row.hasActiveRun!==false||row.permissionModePending!==false))throw nativeError('run_active',409);
 if('model' in desired){
  if(row.hasActiveRun!==false||row.permissionModePending!==false)throw nativeError('conversation_model_change_requires_idle',409);
  const catalog=await readModelOwnerFresh();
  // The app echoes `@acct-…`; the Gateway receives the canonical profile id.
  const real=resolveModelRef(desired.model,knownProfiles(catalog.auth));
  if(!real||!modelCatalogFrom(catalog).includes(real))throw nativeError('unknown_conversation_model',409);
  gatewayModel=real;

 }
 if('thinkingLevel' in desired&&!targetThinking.includes(desired.thinkingLevel))throw nativeError('unsupported_thinking_level');
 const reserved=await reserveSubmittedRun(identity,'native-owner-actions','native-operation-'+body.operationId,{requestText:identity,executionSource:'capability_first',decision:{version:2,type:'EXECUTE',capability:action}});
 if(!reserved.created&&!existing)return await storedNativeOperationResult(reserved.status.runId)||{success:false,state:'indeterminate',receipt:null};
 let state='indeterminate',errorCode:string|undefined,httpStatus:number|undefined;
 try{
  if(await protectedActivity()){state='refused';errorCode='protected_owner_activity';httpStatus=409;}
  else{
   const patch={key,expectedSessionId:row.sessionId,...('title' in desired?{label:desired.title}:{}),...('pinned' in desired?{pinned:desired.pinned}:{}),...(gatewayModel?{model:gatewayModel}:{}),...('thinkingLevel' in desired?{thinkingLevel:desired.thinkingLevel}:{})};
   let rejected:{code:string;status:number}|null=null,patchEntry:any;
   try{const response=await callOpenClawGateway('sessions.patch',patch,readBudget);if(response?.ok===false||response?.success===false)throw response.error||response;patchEntry=response?.entry;}catch(error:any){rejected=refusal(error);}
   if(rejected){state='failed';errorCode=rejected.code;httpStatus=rejected.status;}
   else{
    const observed=await ownerRow(id);
    if(observed.sessionId!==row.sessionId){errorCode='conversation_identity_changed';}
    else{
     const value=projection(id,{...observed,...(patchEntry?.sessionId===observed.sessionId&&'authProfileOverride' in patchEntry?{authProfileOverride:patchEntry.authProfileOverride}:{})});
     const modelMatches=!gatewayModel||(gatewayModel.includes('@')?value.model===gatewayModel:value.model?.split('@')[0]===gatewayModel);
     if((!('title' in desired)||value.title===desired.title)&&(!('pinned' in desired)||value.pinned===desired.pinned)&&modelMatches&&(!('thinkingLevel' in desired)||value.thinkingLevel===desired.thinkingLevel))state='completed';
     else errorCode='conversation_effect_unverified';
    }
   }
  }
 }catch{errorCode='conversation_effect_unverified';}
 const result={success:state==='completed',state,...(errorCode?{error:errorCode}:{}),...(httpStatus?{httpStatus}:{}),...(state==='completed'?{artifact:{sessionId:id}}:{}),receipt:{version:1,action,target,operationId:body.operationId,runId:reserved.status.runId,state,at:reserved.status.submittedAt}};
 await settleSubmittedRun(reserved.status.runId,'done',JSON.stringify(result));
 return await storedNativeOperationResult(reserved.status.runId)||{success:false,state:'indeterminate',receipt:null};
}
