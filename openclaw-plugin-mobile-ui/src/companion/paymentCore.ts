import {createHash, randomBytes, randomUUID, verify, KeyObject} from "crypto";
import type {PaymentAdapter, PaymentDraft, PaymentQuote, PaymentRecord, PaymentStore, PaymentExecutionResult, PaymentContinuation, PaymentExecutionContext} from "./paymentTypes";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const STATES=new Set(["awaiting_owner","executing","demo_confirmed","confirmed","failed","cancelled","expired","blocked","effect_unknown","requires_bank_action"]);
const REASONS=new Set(["gateway_and_provider_confirmed","bank_declined","payment_cancelled","session_expired","bank_verification_required","bank_verification_failed","payment_effect_unverified"]);
export function paymentError(code:string,statusCode=400):never {throw Object.assign(new Error(code),{statusCode});}
function object(value:any,keys:string[]) {
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k))) paymentError("invalid_payment_request");
}
function safeText(v:any,max=120) {return typeof v==="string"&&v.length>0&&v.length<=max&&!/[\p{C}]/u.test(v)&&v===v.trim();}
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
export function validateDraft(v:any):PaymentDraft {
 object(v,["requestKey","adapterId","reference","mode","origin"]);
 object(v.origin,["channel","id"]);
 if(typeof v.requestKey!=="string"||typeof v.adapterId!=="string"||!UUID.test(v.requestKey)||!/^[a-z][a-z0-9_.-]{1,60}$/.test(v.adapterId)||!safeText(v.reference,100)||
 !["demo","live"].includes(v.mode)||!["chatgpt","work","claw","samantha"].includes(v.origin.channel)||!safeText(v.origin.id)) paymentError("invalid_payment_request");
 return {requestKey:v.requestKey,adapterId:v.adapterId,reference:v.reference,mode:v.mode,origin:{channel:v.origin.channel,id:v.origin.id}};
}
export function validateQuote(v:any):PaymentQuote {
 object(v,["payee","reference","amountMinor","currency","decimals"]);
 if(!safeText(v.payee)||!safeText(v.reference,100)||!Number.isSafeInteger(v.amountMinor)||v.amountMinor<0||v.amountMinor>9000000000000||
 typeof v.currency!=="string"||!/^[A-Z]{3}$/.test(v.currency)||!Number.isInteger(v.decimals)||v.decimals<0||v.decimals>3) paymentError("invalid_payment_quote",502);
 return {...v};
}
export function quoteDigest(adapterId:string,mode:string,q:PaymentQuote) {
 return hash(["claw.payment.quote.v1",adapterId,mode,q.payee,q.reference,q.amountMinor,q.currency,q.decimals].join("\n"));
}
function validateContinuation(v:any):PaymentContinuation {
 object(v,["provider","checkoutId","gatewayOrderId"]);
 if(typeof v.provider!=="string"||!/^[a-z][a-z0-9_.-]{1,60}$/.test(v.provider)||
  typeof v.checkoutId!=="string"||!/^[0-9]{1,32}$/.test(v.checkoutId)||
  typeof v.gatewayOrderId!=="string"||!UUID.test(v.gatewayOrderId))paymentError("invalid_payment_continuation",502);
 return {provider:v.provider,checkoutId:v.checkoutId,gatewayOrderId:v.gatewayOrderId};
}
export function confirmationMessage(r:PaymentRecord) {
 return ["claw.payment.owner.v1",r.id,r.nonce,r.quoteHash,r.expiresAt,r.keyId].join("\n");
}
export {ownerKey} from "./ownerConfirmationProtocol";
function validateStored(r:PaymentRecord) {
 if(!r||r.version!==1||!UUID.test(r.id)||!STATES.has(r.state)||!HEX.test(r.nonce)||!HEX.test(r.keyId)||
 !HEX.test(r.quoteHash)||!HEX.test(r.fingerprint)||!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.expiresAt)||
 r.expiresAt-r.createdAt!==120000||!Number.isSafeInteger(r.executorAttempts)||r.executorAttempts<0||r.executorAttempts>1||
 !Number.isSafeInteger(r.bankResumeAttempts)||r.bankResumeAttempts<0||r.bankResumeAttempts>1||
 (r.bankReturnTokenHash!==undefined&&!HEX.test(r.bankReturnTokenHash))) paymentError("payment_record_invalid",503);
 const d=validateDraft(r.draft),q=validateQuote(r.quote);
 if(r.continuation!==undefined){const c=validateContinuation(r.continuation);if(c.provider!==d.adapterId)paymentError("payment_record_invalid",503);}
 if(quoteDigest(d.adapterId,d.mode,q)!==r.quoteHash||hash(JSON.stringify(d))!==r.fingerprint) paymentError("payment_record_invalid",503);
}
export function paymentView(r:PaymentRecord) {
 return {schemaVersion:1,requestId:r.id,adapterId:r.draft.adapterId,mode:r.draft.mode,origin:r.draft.origin,
 quote:r.quote,state:r.state,reasonCode:r.reasonCode,expiresAt:r.expiresAt,canRetry:false,
 financialSubmissionAttempted:r.draft.mode==="live"&&r.executorAttempts>0,
 receipt:r.state==="confirmed"?r.receipt:undefined,
 metrics:{preparationMs:r.preparationMs,ownerWaitMs:r.acceptedAt===undefined?null:Math.max(0,r.acceptedAt-r.createdAt),
 executionMs:r.endedAt===undefined||r.executionStartedAt===undefined?null:Math.max(0,r.endedAt-r.executionStartedAt),
 bankWaitMs:r.resumedAt===undefined||r.bankActionRequiredAt===undefined?null:Math.max(0,r.resumedAt-r.bankActionRequiredAt),
 totalMs:r.endedAt===undefined?null:Math.max(0,r.endedAt-r.createdAt+r.preparationMs),executorAttempts:r.executorAttempts,bankResumeAttempts:r.bankResumeAttempts??0}};
}
export function createPaymentCore(options:{store:PaymentStore;adapters:PaymentAdapter[];key:()=>{key:KeyObject;id:string};clock?:()=>number;timeouts?:{quoteMs?:number;executionMs?:number}}) {
 const now=options.clock||Date.now,bootId=randomUUID(),adapters=new Map<string,PaymentAdapter>();
 for(const a of options.adapters) {
  if(adapters.has(a.id)||!/^[a-z][a-z0-9_.-]{1,60}$/.test(a.id)||!["demo","live"].includes(a.mode)||
   (a.executionValidated&&(!a.quote||!a.revalidate||!a.execute||(a.mode==="live"&&!a.resume)))) paymentError("invalid_payment_adapter",503);
  adapters.set(a.id,a);
 }
 const quoteMs=options.timeouts?.quoteMs??10000,executionMs=options.timeouts?.executionMs??45000;
 if(!Number.isInteger(quoteMs)||quoteMs<1||quoteMs>45000||!Number.isInteger(executionMs)||executionMs<1||executionMs>240000)paymentError("invalid_payment_timeout",503);
 async function bounded<T>(operation:()=>Promise<T>,ms:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(new Error("payment_adapter_timeout")),ms);
  })]);} finally {if(timer)clearTimeout(timer);}
 }
 const available=(id:string,mode:string)=>{
  const a=adapters.get(id);
  if(!a) paymentError("payment_adapter_unavailable",409);
  if(a.mode!==mode) paymentError("payment_adapter_mode_mismatch",409);
  if(!a.executionValidated) paymentError(a.unavailableReason||"payment_contract_unverified",409);
  return a;
 };
 const normalize=(r:PaymentRecord)=>{
  if(r.bankResumeAttempts===undefined)r.bankResumeAttempts=0;
  validateStored(r);
  if(r.state==="awaiting_owner"&&(now()>=r.expiresAt||now()<r.createdAt)) {
   r.state="expired";r.reasonCode="owner_confirmation_expired";r.endedAt=now();r.updatedAt=now();
  }
  if(r.state==="executing"&&r.executionBootId!==bootId) {
   r.state="effect_unknown";r.reasonCode="execution_interrupted";r.endedAt=now();r.updatedAt=now();
  }
  return r;
 };
 const locate=(rows:PaymentRecord[],id:string)=>{
  if(!UUID.test(id))paymentError("invalid_payment_request");
  const r=rows.find(x=>x.id===id);
  if(!r)paymentError("payment_request_not_found",404);
  return normalize(r);
 };
 const finish=async(id:string,state:PaymentRecord["state"],reason:string,receipt?:PaymentRecord["receipt"],continuation?:PaymentContinuation)=>options.store.change(rows=>{
  const r=locate(rows,id);
  if(r.state!=="executing")return paymentView(r);
  r.state=state;r.reasonCode=reason;r.receipt=receipt;r.updatedAt=now();
  if(state==="requires_bank_action"){
   if(!continuation)paymentError("invalid_payment_continuation",502);
   const c=validateContinuation(continuation);if(c.provider!==r.draft.adapterId)paymentError("invalid_payment_continuation",502);
   r.continuation=c;r.bankActionRequiredAt=now();delete r.endedAt;
  } else {r.endedAt=now();delete r.bankReturnTokenHash;}
  return paymentView(r);
 });
 const applyResult=async(id:string,mode:PaymentDraft["mode"],result:PaymentExecutionResult)=>{
  if(!result||!["confirmed","failed","effect_unknown","requires_bank_action"].includes(result.state)||!REASONS.has(result.reasonCode))
   return finish(id,"effect_unknown","invalid_payment_adapter_result");
  const reasons:Record<string,string[]>={confirmed:["gateway_and_provider_confirmed"],
   failed:["bank_declined","bank_verification_failed","payment_cancelled","session_expired"],
   requires_bank_action:["bank_verification_required"],effect_unknown:["payment_effect_unverified"]};
  if(!reasons[result.state].includes(result.reasonCode))return finish(id,"effect_unknown","invalid_payment_adapter_result");
  if(result.state==="failed"&&result.rejectionVerified!==true)return finish(id,"effect_unknown","payment_rejection_unverified");
  if(mode==="demo") {
   if(result.state!=="confirmed")return finish(id,"effect_unknown","demo_result_unverified");
   return finish(id,"demo_confirmed","demo_only_no_payment");
  }
  if(result.state==="requires_bank_action") {
   if(!result.continuation)return finish(id,"effect_unknown","payment_effect_unverified");
   return finish(id,"requires_bank_action",result.reasonCode,undefined,result.continuation);
  }
  if(result.state==="confirmed") {
   const receipt=result.receipt;
   if(!receipt||!safeText(receipt.reference)||receipt.transactionCorrelated!==true||receipt.providerReconciled!==true)
    return finish(id,"effect_unknown","payment_receipt_unverified");
   return finish(id,"confirmed",result.reasonCode,{reference:receipt.reference,transactionCorrelated:true,providerReconciled:true});
  }
  return finish(id,result.state,result.reasonCode);
 };
 return {
  capabilities:()=>({schemaVersion:1,capability:"payment.owner_native",ownerConfirmation:"native_key_required",
   realPaymentsEnabled:[...adapters.values()].some(a=>a.mode==="live"&&a.executionValidated),
   adapters:[...adapters.values()].map(a=>({id:a.id,label:a.label,mode:a.mode,executionValidated:a.executionValidated,reasonCode:a.unavailableReason||null}))}),
  async prepare(input:any) {
   const draft=validateDraft(input),fingerprint=hash(JSON.stringify(draft)),started=now();
   const previous=(await options.store.read()).find(r=>r.draft.requestKey===draft.requestKey);
   if(previous) return options.store.change(rows=>{
    const r=locate(rows,previous.id);if(r.fingerprint!==fingerprint)paymentError("payment_request_key_conflict",409);return paymentView(r);
   });
   const adapter=available(draft.adapterId,draft.mode),key=options.key(),quote=validateQuote(await bounded(()=>adapter.quote!(draft.reference),quoteMs));
   if(quote.reference!==draft.reference||draft.mode==="live"&&quote.amountMinor<=0)paymentError("invalid_payment_quote",502);
   const created=now();
   return options.store.change(rows=>{
    const old=rows.find(r=>r.draft.requestKey===draft.requestKey);
    if(old) {normalize(old);if(old.fingerprint!==fingerprint)paymentError("payment_request_key_conflict",409);return paymentView(old);}
    if(draft.mode==="live"&&rows.some(r=>{
     normalize(r);
     return r.draft.mode==="live"&&r.draft.adapterId===draft.adapterId&&r.quote.reference===quote.reference&&
       ["awaiting_owner","executing","effect_unknown","requires_bank_action","confirmed"].includes(r.state);
    }))paymentError("payment_for_reference_already_guarded",409);
    // Retain consumed keys; do not evict payment guards with ordinary chat history.
    if(rows.length>=1000)paymentError("payment_registry_capacity_reached",409);
    const r:PaymentRecord={version:1,id:randomUUID(),draft,fingerprint,quote,quoteHash:quoteDigest(draft.adapterId,draft.mode,quote),
     nonce:randomBytes(32).toString("hex"),keyId:key.id,createdAt:created,expiresAt:created+120000,updatedAt:created,
     state:"awaiting_owner",reasonCode:"owner_confirmation_required",preparationMs:Math.max(0,created-started),executorAttempts:0,bankResumeAttempts:0};
    rows.push(r);return paymentView(r);
   });
  },
  async status(id:string) {return options.store.change(rows=>paymentView(locate(rows,id)));},
  async challenge(id:string) {
   return options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state!=="awaiting_owner")paymentError("payment_request_not_pending",409);
    available(r.draft.adapterId,r.draft.mode);
    if(options.key().id!==r.keyId)paymentError("owner_key_changed",409);
    return {...paymentView(r),nonce:r.nonce,keyId:r.keyId,quoteHash:r.quoteHash,challenge:confirmationMessage(r)};
   });
  },
  async cancel(id:string) {
   return options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state==="awaiting_owner"){r.state="cancelled";r.reasonCode="owner_cancelled";r.endedAt=now();r.updatedAt=now();}
    // Never interpret cancellation after dispatch as a bank cancellation.
    return paymentView(r);
   });
  },
  async confirm(id:string,proof:any) {
   object(proof,["keyId","nonce","quoteHash","signature"]);
   if(!HEX.test(proof.keyId)||!HEX.test(proof.nonce)||!HEX.test(proof.quoteHash)||typeof proof.signature!=="string"||
    !/^[A-Za-z0-9+/]{80,120}={0,2}$/.test(proof.signature))paymentError("invalid_owner_proof",403);
   const claimed=await options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state!=="awaiting_owner")paymentError("payment_confirmation_already_consumed",409);
    available(r.draft.adapterId,r.draft.mode);
    const key=options.key();
    if(key.id!==r.keyId||proof.keyId!==r.keyId||proof.nonce!==r.nonce||proof.quoteHash!==r.quoteHash||
     !verify("sha256",Buffer.from(confirmationMessage(r),"utf8"),key.key,Buffer.from(proof.signature,"base64")))paymentError("invalid_owner_proof",403);
    r.acceptedAt=now();r.state="executing";r.reasonCode="owner_confirmed";r.executionBootId=bootId;r.updatedAt=now();
    return JSON.parse(JSON.stringify(r)) as PaymentRecord;
   });
   const adapter=available(claimed.draft.adapterId,claimed.draft.mode);
   try {
    const fresh=validateQuote(await bounded(()=>adapter.revalidate!(claimed.quote),quoteMs));
    if(quoteDigest(claimed.draft.adapterId,claimed.draft.mode,fresh)!==claimed.quoteHash)
     return finish(id,"blocked","payment_quote_changed");
   } catch {return finish(id,"blocked","payment_revalidation_failed");}
   // Persist dispatch BEFORE calling an adapter. An uncertain effect is never replayed.
   const bankReturnToken=claimed.draft.mode==="live"?randomBytes(32).toString("base64url"):undefined;
   try { await options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state!=="executing"||r.executorAttempts!==0)paymentError("payment_dispatch_not_available",409);
    if(now()>=r.expiresAt||now()<r.createdAt)paymentError("payment_authorization_expired",409);
    available(r.draft.adapterId,r.draft.mode);
    if(options.key().id!==r.keyId)paymentError("owner_key_changed",409);
    r.executionStartedAt=now();r.executorAttempts=1;
    if(bankReturnToken)r.bankReturnTokenHash=hash(bankReturnToken);
    r.updatedAt=now();return true;
   }); } catch { return finish(id,"blocked","payment_dispatch_precondition_changed"); }
   try {
    const context:PaymentExecutionContext|undefined=bankReturnToken?{bankReturnToken}:undefined;
    const result:PaymentExecutionResult=await bounded(()=>adapter.execute!(claimed.quote,id,context),executionMs);
    return applyResult(id,claimed.draft.mode,result);
   } catch {return finish(id,"effect_unknown","payment_effect_unverified");}
  },
  async resume(id:string) {
   const claimed=await options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state!=="requires_bank_action"||r.executorAttempts!==1||r.bankResumeAttempts!==0)
     paymentError("payment_resume_not_available",409);
    const adapter=available(r.draft.adapterId,r.draft.mode);
    if(typeof adapter.resume!=="function"||!r.continuation)paymentError("payment_resume_not_available",409);
    r.state="executing";r.reasonCode="bank_action_resuming";r.executionBootId=bootId;
    r.bankResumeAttempts=1;r.resumedAt=now();delete r.bankReturnTokenHash;r.updatedAt=now();
    return JSON.parse(JSON.stringify(r)) as PaymentRecord;
   });
   const adapter=available(claimed.draft.adapterId,claimed.draft.mode);
   try {
    const result:PaymentExecutionResult=await bounded(()=>adapter.resume!(claimed.quote,id,claimed.continuation),executionMs);
    return applyResult(id,claimed.draft.mode,result);
   } catch {return finish(id,"effect_unknown","payment_effect_unverified");}
  },
  async resumeFromBankReturn(id:string,bankReturnToken:string) {
   if(typeof bankReturnToken!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(bankReturnToken))paymentError("invalid_bank_return_token",403);
   const claimed=await options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state!=="requires_bank_action"||r.executorAttempts!==1||r.bankResumeAttempts!==0||!r.bankReturnTokenHash||
      hash(bankReturnToken)!==r.bankReturnTokenHash)paymentError("payment_bank_return_not_available",409);
    const adapter=available(r.draft.adapterId,r.draft.mode);
    if(typeof adapter.resume!=="function"||!r.continuation)paymentError("payment_resume_not_available",409);
    r.state="executing";r.reasonCode="bank_action_resuming";r.executionBootId=bootId;
    r.bankResumeAttempts=1;r.resumedAt=now();delete r.bankReturnTokenHash;r.updatedAt=now();
    return JSON.parse(JSON.stringify(r)) as PaymentRecord;
   });
   const adapter=available(claimed.draft.adapterId,claimed.draft.mode);
   try {
    const result:PaymentExecutionResult=await bounded(()=>adapter.resume!(claimed.quote,id,claimed.continuation),executionMs);
    return applyResult(id,claimed.draft.mode,result);
   } catch {return finish(id,"effect_unknown","payment_effect_unverified");}
  }
 };
}
