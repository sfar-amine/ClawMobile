import {createHash} from "crypto";
import {callOpenClawGateway,expectedCompanionSessionKey} from "./openclawAgentClient";
import {readPaymentRequests,readOwnerConfirmations} from "./runs";
import {nativeError,nativeOperation,existingNativeOperation} from "./nativeOperation";

const operationPattern=/^[-A-Za-z0-9_.:]{1,128}$/;
const modelPattern=/^[A-Za-z0-9._:+-]+\/[A-Za-z0-9._:/+-]{1,160}$/;
function session(id:string){if(!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)||id.length>80)throw nativeError('invalid_session_id');return expectedCompanionSessionKey(id);}
async function ownerRow(id:string){
 const key=session(id),value=await callOpenClawGateway('sessions.list',{search:key,limit:20},{timeoutMs:3500});
 if(!Array.isArray(value?.sessions)||value.sessions.length>20)throw nativeError('conversation_owner_unavailable',503);
 const matches=value.sessions.filter((row:any)=>row.key===key);
 if(matches.length!==1)throw nativeError(matches.length?'conversation_identity_ambiguous':'conversation_not_found',matches.length?409:404);
 return matches[0];
}
function projection(id:string,row:any){
 const title=typeof row.label==='string'&&row.label.length<=160&&!/[\x00-\x1f\x7f]/.test(row.label)?row.label:null;
 const pinned=typeof row.pinned==='boolean'?row.pinned:null;
 const ref=(provider:string,model:string)=>model.startsWith(provider+'/')?model:provider+'/'+model;
 const effective=typeof row.model==='string'&&typeof row.modelProvider==='string'?ref(row.modelProvider,row.model):null;
 const model=typeof row.modelOverride==='string'&&typeof row.providerOverride==='string'?ref(row.providerOverride,row.modelOverride):effective;
 return {success:true,state:'ok',receipt:null,sessionId:id,title,pinned,model:model&&modelPattern.test(model)?model:null,
  modelSource:row.modelOverride?'session_override':'gateway_effective',mutationAvailable:typeof row.sessionId==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(row.sessionId),
  issues:[...(pinned===null?['conversation_pin_unknown']:[]),...(!model?['conversation_model_unknown']:[])]};
}
export async function readConversationMetadata(id:string){return projection(id,await ownerRow(id));}
async function protectedActivity(){
 const [payments,confirmations]=await Promise.all([readPaymentRequests(),readOwnerConfirmations()]);
 return payments.some(row=>['awaiting_owner','executing','effect_unknown','requires_bank_action'].includes(row.state))||confirmations.some(row=>row.state==='awaiting_owner'&&row.expiresAt>Date.now());
}
export async function changeConversationMetadata(id:string,body:any){
 const key=session(id);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['operationId','title','pinned','model'].includes(k))||typeof body.operationId!=='string'||!operationPattern.test(body.operationId)||!['title','pinned','model'].some(k=>k in body)||
  ('title' in body&&(typeof body.title!=='string'||!body.title.trim()||body.title.length>120||/[\x00-\x1f\x7f]/.test(body.title)))||
  ('pinned' in body&&typeof body.pinned!=='boolean')||('model' in body&&(typeof body.model!=='string'||!modelPattern.test(body.model))))throw nativeError('invalid_conversation_metadata');
 const desired={...('title' in body?{title:body.title}:{}),...('pinned' in body?{pinned:body.pinned}:{}),...('model' in body?{model:body.model}:{})};
 const action='conversation.metadata',target=createHash('sha256').update(JSON.stringify({sessionId:id,...desired})).digest('hex');
 const existing=await existingNativeOperation(body.operationId,JSON.stringify({action,target}));if(existing)return existing;
 const row=await ownerRow(id);
 if(typeof row.sessionId!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(row.sessionId))throw nativeError('conversation_identity_unavailable',409);
 if(await protectedActivity())throw nativeError('protected_owner_activity',409);
 if('model' in desired){
  if(row.hasActiveRun!==false||row.permissionModePending!==false)throw nativeError('conversation_model_change_requires_idle',409);
  const catalog=await callOpenClawGateway('models.list',{}, {timeoutMs:3500});
  if(!Array.isArray(catalog?.models)||catalog.models.length>2000)throw nativeError('conversation_model_catalog_unavailable',503);
  if(!catalog.models.some((model:any)=>typeof model.id==='string'&&typeof model.provider==='string'&&(model.id.startsWith(model.provider+'/')?model.id:model.provider+'/'+model.id)===desired.model))throw nativeError('unknown_conversation_model',409);
 }
 return nativeOperation(body.operationId,action,target,async()=>{
  if(await protectedActivity())return {state:'refused',artifact:{reason:'protected_owner_activity'}};
  const patch={key,expectedSessionId:row.sessionId,...('title' in desired?{label:desired.title}:{}),...('pinned' in desired?{pinned:desired.pinned}:{}),...('model' in desired?{model:desired.model}:{})};
  try{await callOpenClawGateway('sessions.patch',patch,{timeoutMs:10000});}
  catch{/* The effect may have started; observe once, never redispatch. */}
  const observed=await ownerRow(id);
  if(observed.sessionId!==row.sessionId)throw nativeError('conversation_identity_changed',409);
  const value=projection(id,observed);
  if(('title' in desired&&value.title!==desired.title)||('pinned' in desired&&value.pinned!==desired.pinned)||('model' in desired&&value.model!==desired.model))throw nativeError('conversation_effect_unverified',503);
  return {state:'completed',artifact:{sessionId:id}};
 });
}
