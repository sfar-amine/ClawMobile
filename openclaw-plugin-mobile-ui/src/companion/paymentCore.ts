import {createHash, randomBytes, randomUUID, verify, KeyObject} from "crypto";
import type {PaymentAdapter, PaymentDraft, PaymentQuote, PaymentRecord, PaymentStore, PaymentExecutionResult, PaymentContinuation, PaymentExecutionContext, PaymentTraceInput} from "./paymentTypes";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const STATES=new Set(["awaiting_owner","executing","demo_confirmed","confirmed","failed","cancelled","expired","blocked","effect_unknown","requires_bank_action"]);
const REASONS=new Set(["gateway_and_provider_confirmed","bank_declined","payment_cancelled","session_expired","bank_verification_required","bank_verification_failed","payment_rejected_reason_unavailable","payment_effect_unverified"]);
const TRACE_STAGES=new Set(["owner_confirmation_consumed","payment_record_created","financial_dispatch_committed","provider_session_started","provider_session_authenticated","invoice_revalidated","checkout_prepared","browser_context_ready","three_ds2_preflight","gateway_submission_started","gateway_submission_result","bank_ui_opened","bank_ui_navigation","bank_ui_lifecycle","bank_return_detected","bank_return_requested","bank_return_response","bank_result_presented","provider_callback_correlated","provider_readback","completion_classified","execution_error","bank_timeout_reconciliation_started","bank_resume_started","state_transition","http_exchange"]);
const TRACE_INVOICE_STATES=new Set(["unpaid","settled","balance_changed","not_observed","unknown"]);
const TRACE_CAPACITY=160,TRACE_SNAPSHOT_MAX=65536;
export const BANK_ACTION_TIMEOUT_MS=60_000;
export function paymentError(code:string,statusCode=400):never {throw Object.assign(new Error(code),{statusCode});}
function object(value:any,keys:string[]) {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k))) paymentError("invalid_payment_request");
}
function safeText(v:any,max=120) {return typeof v==="string"&&v.length>0&&v.length<=max&&!/[\p{C}]/u.test(v)&&v===v.trim();}
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
const TRACE_SECRET_NAME=/(?:^|[_$.-])(pan|cvc|cvv|expir(?:y|ation)?|password|passwd|pwd|pin|otp|one.?time|creq|pareq|threedsmethoddata(?:packed)?|csrf|xsrf|nonce|signature|secret|auth(?:orization)?|cookie|session(?:id)?|sid|token)(?:$|[_$.-])/i;
const TRACE_PERSONAL_NAME=/^(?:text|cardholder|holder|email|phone|postalcode|streetaddress|login|username|user)$/i;
const TRACE_PAN=/\b(?:\d ?){13,19}\b/,TRACE_BEARER=/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i;
function traceSensitiveName(v:any){return typeof v==="string"&&(TRACE_SECRET_NAME.test(v)||TRACE_PERSONAL_NAME.test(v)||["$PAN","$CVC","$EXPIRY","MM","YYYY"].includes(v));}
function traceRedaction(v:any){return !!v&&typeof v==="object"&&!Array.isArray(v)&&v.redacted===true&&Number.isSafeInteger(v.bytes)&&v.bytes>=0&&v.bytes<=2000000&&Object.keys(v).sort().join(",")==="bytes,redacted";}
function traceNodeSafe(v:any,key=""):boolean{
  if(traceSensitiveName(key))return traceRedaction(v);
  if(v===null||typeof v==="boolean"||typeof v==="number")return true;
  if(typeof v==="string")return v.length<=TRACE_SNAPSHOT_MAX&&!TRACE_PAN.test(v)&&!TRACE_BEARER.test(v)&&!v.includes("\u0000");
  if(Array.isArray(v))return v.length<=512&&v.every(x=>traceNodeSafe(x));
  if(!v||typeof v!=="object")return false;
  if(typeof v.name==="string"&&traceSensitiveName(v.name)&&Object.prototype.hasOwnProperty.call(v,"value")&&!traceRedaction(v.value))return false;
  return Object.entries(v).every(([k,x])=>traceNodeSafe(x,k));
}
function safeSnapshot(v:any){
  if(typeof v!=="string"||Buffer.byteLength(v)>TRACE_SNAPSHOT_MAX||v.includes("\u0000"))return false;
  try{return traceNodeSafe(JSON.parse(v));}catch{return false;}
}
function cleanHttpTrace(value:any){
  if(!value||typeof value!=="object"||Array.isArray(value))paymentError("invalid_payment_trace",503);
  const out:any={};
  if(!["GET","POST"].includes(value.method)||typeof value.origin!=="string"||!/^https:\/\/[^\s/]+$/.test(value.origin)||
    typeof value.path!=="string"||!value.path.startsWith("/")||value.path.length>512||
    !Number.isSafeInteger(value.requestBytes)||value.requestBytes<0||value.requestBytes>2000000||
    !safeSnapshot(value.requestSnapshot)||!HEX.test(value.requestSha256)||typeof value.requestTruncated!=="boolean"||
    !Number.isSafeInteger(value.durationMs)||value.durationMs<0||value.durationMs>120000)paymentError("invalid_payment_trace",503);
  Object.assign(out,{method:value.method,origin:value.origin,path:value.path,requestBytes:value.requestBytes,
    requestSnapshot:value.requestSnapshot,requestSha256:value.requestSha256,requestTruncated:value.requestTruncated,durationMs:value.durationMs});
  if(value.responseStatus!==undefined){
    if(!Number.isSafeInteger(value.responseStatus)||value.responseStatus<0||value.responseStatus>599||
      typeof value.responseOrigin!=="string"||!/^https:\/\/[^\s/]+$/.test(value.responseOrigin)||
      typeof value.responsePath!=="string"||!value.responsePath.startsWith("/")||value.responsePath.length>512||
      !Number.isSafeInteger(value.responseBytes)||value.responseBytes<0||value.responseBytes>2000000||
      !safeSnapshot(value.responseSnapshot)||!HEX.test(value.responseSha256)||typeof value.responseTruncated!=="boolean")
      paymentError("invalid_payment_trace",503);
    Object.assign(out,{responseStatus:value.responseStatus,responseOrigin:value.responseOrigin,responsePath:value.responsePath,
      responseBytes:value.responseBytes,responseSnapshot:value.responseSnapshot,responseSha256:value.responseSha256,responseTruncated:value.responseTruncated});
  }
  if(value.errorCode!==undefined){if(!safeText(value.errorCode,96))paymentError("invalid_payment_trace",503);out.errorCode=value.errorCode;}
  if(value.responseStatus===undefined&&value.errorCode===undefined)paymentError("invalid_payment_trace",503);
  return out;
}
const BANK_UI_TRACE_STAGES=new Set(["bank_ui_navigation","bank_ui_lifecycle","bank_return_detected","bank_return_requested","bank_return_response","bank_result_presented"]);
function cleanNavigationTrace(value:any,allowedOrigins:ReadonlySet<string>){
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="origin,path"||
     typeof value.origin!=="string"||!allowedOrigins.has(value.origin)||
     typeof value.path!=="string"||value.path.length<1||value.path.length>256||!value.path.startsWith("/")||
     value.path.includes("?")||value.path.includes("#")||!/^\/[A-Za-z0-9_{}./-]*$/.test(value.path))
    paymentError("invalid_payment_trace",503);
  return {origin:value.origin,path:value.path};
}
function cleanTraceInput(value:PaymentTraceInput,allowedOrigins:ReadonlySet<string>=new Set()):PaymentTraceInput {
  if(!value||typeof value!=="object"||Array.isArray(value)||!TRACE_STAGES.has(value.stage))paymentError("invalid_payment_trace",503);
  const out:PaymentTraceInput={stage:value.stage};
  if(value.outcome!==undefined){if(!safeText(value.outcome,64))paymentError("invalid_payment_trace",503);out.outcome=value.outcome;}
  if(value.reasonCode!==undefined){if(!safeText(value.reasonCode,96))paymentError("invalid_payment_trace",503);out.reasonCode=value.reasonCode;}
  if(value.invoiceState!==undefined){if(!TRACE_INVOICE_STATES.has(value.invoiceState))paymentError("invalid_payment_trace",503);out.invoiceState=value.invoiceState;}
  if(value.clientAt!==undefined){
    if(value.stage!=="bank_ui_lifecycle"||!Number.isSafeInteger(value.clientAt)||value.clientAt<=0)paymentError("invalid_payment_trace",503);
    out.clientAt=value.clientAt;
  }
  if(value.http!==undefined){if(value.stage!=="http_exchange")paymentError("invalid_payment_trace",503);out.http=cleanHttpTrace(value.http);}
  if(value.stage==="http_exchange"&&!out.http)paymentError("invalid_payment_trace",503);
  if(value.navigation!==undefined){
    if(!["bank_ui_navigation","bank_return_detected"].includes(value.stage))paymentError("invalid_payment_trace",503);
    out.navigation=cleanNavigationTrace(value.navigation,allowedOrigins);
  }
  if(value.stage==="bank_ui_navigation"&&!out.navigation)paymentError("invalid_payment_trace",503);
  return out;
}
function appendTrace(r:PaymentRecord,value:PaymentTraceInput,at:number,allowedOrigins:ReadonlySet<string>=new Set()){
  const item=cleanTraceInput(value,allowedOrigins),trace=r.trace??(r.trace=[]);
  if(item.clientAt!==undefined&&(item.clientAt<at-120000||item.clientAt>at+5000))paymentError("invalid_payment_trace",503);
  if(trace.length>=TRACE_CAPACITY)paymentError("payment_trace_capacity_reached",503);
  trace.push({...item,seq:trace.length+1,at});
}
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
function validateStored(r:PaymentRecord,allowedOrigins:ReadonlySet<string>=new Set()) {
  if(!r||r.version!==1||!UUID.test(r.id)||!STATES.has(r.state)||!HEX.test(r.nonce)||!HEX.test(r.keyId)||
    !HEX.test(r.quoteHash)||!HEX.test(r.fingerprint)||!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.expiresAt)||
    r.expiresAt-r.createdAt!==120000||!Number.isSafeInteger(r.executorAttempts)||r.executorAttempts<0||r.executorAttempts>1||
    !Number.isSafeInteger(r.bankResumeAttempts)||r.bankResumeAttempts<0||r.bankResumeAttempts>1||
    (r.bankReturnTokenHash!==undefined&&!HEX.test(r.bankReturnTokenHash))) paymentError("payment_record_invalid",503);
  if(r.authorizationSource!=="payment_owner_native"&&r.authorizationSource!=="local_owner_confirmation") paymentError("payment_record_invalid",503);
  if(r.authorizationSource==="local_owner_confirmation"&&(!r.ownerConfirmationId||!UUID.test(r.ownerConfirmationId))) paymentError("payment_record_invalid",503);
  if(r.trace!==undefined){
    if(!Array.isArray(r.trace)||r.trace.length>TRACE_CAPACITY)paymentError("payment_record_invalid",503);
    for(let i=0;i<r.trace.length;i++){
      const e=r.trace[i] as any;
      if(!e||e.seq!==i+1||!Number.isSafeInteger(e.at)||e.at<r.createdAt-120000||e.at>r.updatedAt+120000)paymentError("payment_record_invalid",503);
      const cleaned=cleanTraceInput(e,allowedOrigins);
      if(cleaned.clientAt!==undefined&&(cleaned.clientAt<e.at-120000||cleaned.clientAt>e.at+5000))paymentError("payment_record_invalid",503);
    }
  }
  const d=validateDraft(r.draft),q=validateQuote(r.quote);
  if(r.continuation!==undefined){const c=validateContinuation(r.continuation);if(c.provider!==d.adapterId)paymentError("payment_record_invalid",503);}
  if(quoteDigest(d.adapterId,d.mode,q)!==r.quoteHash||hash(JSON.stringify(d))!==r.fingerprint) paymentError("payment_record_invalid",503);
}
export function paymentView(r:PaymentRecord) {
  return {schemaVersion:1,requestId:r.id,adapterId:r.draft.adapterId,mode:r.draft.mode,origin:r.draft.origin,
    quote:r.quote,state:r.state,reasonCode:r.reasonCode,expiresAt:r.expiresAt,canRetry:false,
    financialSubmissionAttempted:r.draft.mode==="live"&&r.executorAttempts>0,
    timeline:(r.trace??[]).map(e=>({...e})),
    receipt:r.state==="confirmed"?r.receipt:undefined,
    metrics:{preparationMs:r.preparationMs,ownerWaitMs:r.acceptedAt===undefined?null:Math.max(0,r.acceptedAt-r.createdAt),
      executionMs:r.endedAt===undefined||r.executionStartedAt===undefined?null:Math.max(0,r.endedAt-r.executionStartedAt),
      bankWaitMs:r.resumedAt===undefined||r.bankActionRequiredAt===undefined?null:Math.max(0,r.resumedAt-r.bankActionRequiredAt),
      totalMs:r.endedAt===undefined?null:Math.max(0,r.endedAt-r.createdAt+r.preparationMs),executorAttempts:r.executorAttempts,bankResumeAttempts:r.bankResumeAttempts??0}};
}
export function createPaymentCore(options:{store:PaymentStore;adapters:PaymentAdapter[];key:()=>{key:KeyObject;id:string};clock?:()=>number;timeouts?:{quoteMs?:number;executionMs?:number}}) {
  const now=options.clock||Date.now,bootId=randomUUID(),adapters=new Map<string,PaymentAdapter>();
  for(const a of options.adapters) {
    if(adapters.has(a.id)||!/^[a-z][a-z0-9_.-]{1,60}$/.test(a.id)||!["demo","live"].includes(a.mode)) paymentError("invalid_payment_adapter",503);
    if(a.executionValidated&&(!a.quote||!a.revalidate||!a.execute||(a.mode==="live"&&!a.resume))) paymentError("invalid_payment_adapter",503);
    if(a.bankNavigationOrigins!==undefined){
      if(!Array.isArray(a.bankNavigationOrigins)||a.bankNavigationOrigins.length>12||new Set(a.bankNavigationOrigins).size!==a.bankNavigationOrigins.length) paymentError("invalid_payment_adapter",503);
      for(const raw of a.bankNavigationOrigins){
        try{const u=new URL(raw);if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||u.pathname!=="/"||u.port)paymentError("invalid_payment_adapter",503);}
        catch{paymentError("invalid_payment_adapter",503);}
      }
    }
    if(a.localOwnerValidated===true&&(a.mode!=="live"||!a.quote||typeof a.executeLocal!=="function"||typeof a.resume!=="function")) paymentError("invalid_payment_adapter",503);
    adapters.set(a.id,a);
  }
  const bankOriginsFor=(adapterId:string)=>new Set(adapters.get(adapterId)?.bankNavigationOrigins??[]);
  const quoteMs=options.timeouts?.quoteMs??10000,executionMs=options.timeouts?.executionMs??45000;
  if(!Number.isInteger(quoteMs)||quoteMs<1||quoteMs>45000||!Number.isInteger(executionMs)||executionMs<1||executionMs>240000)paymentError("invalid_payment_timeout",503);
  async function bounded<T>(operation:()=>Promise<T>,ms:number):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error("payment_adapter_timeout")),ms);
    })]);} finally {if(timer)clearTimeout(timer);}
  }
  const baseAdapter=(id:string,mode:string)=>{
    const a=adapters.get(id);
    if(!a) paymentError("payment_adapter_unavailable",409);
    if(a.mode!==mode) paymentError("payment_adapter_mode_mismatch",409);
    return a;
  };
  const availableExternal=(id:string,mode:string)=>{
    const a=baseAdapter(id,mode);
    if(!a.executionValidated) paymentError(a.unavailableReason||"payment_contract_unverified",409);
    return a;
  };
  const availableLocal=(id:string,mode:string)=>{
    const a=baseAdapter(id,mode);
    if(
      mode!=="live" ||
      a.localOwnerValidated!==true ||
      typeof a.executeLocal!=="function" ||
      typeof a.resume!=="function"
    ) paymentError("local_owner_payment_contract_unverified",409);
    return a;
  };
  const availableForRecord=(r:PaymentRecord)=>{
    return r.authorizationSource==="local_owner_confirmation"
      ? availableLocal(r.draft.adapterId,r.draft.mode)
      : availableExternal(r.draft.adapterId,r.draft.mode);
  };
  const normalize=(r:PaymentRecord)=>{
    if(r.bankResumeAttempts===undefined)r.bankResumeAttempts=0;
    if(!r.authorizationSource)(r as any).authorizationSource="payment_owner_native";
    validateStored(r,bankOriginsFor(r.draft?.adapterId));
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
    const at=now();
    r.state=state;r.reasonCode=reason;r.receipt=receipt;r.updatedAt=at;
    appendTrace(r,{stage:"state_transition",outcome:state,reasonCode:reason},at);
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
      failed:["bank_declined","bank_verification_failed","payment_cancelled","session_expired","payment_rejected_reason_unavailable"],
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
      localOwnerPaymentsEnabled:[...adapters.values()].some(a=>a.mode==="live"&&a.localOwnerValidated===true&&typeof a.executeLocal==="function"&&typeof a.resume==="function"),
      adapters:[...adapters.values()].map(a=>({id:a.id,label:a.label,mode:a.mode,executionValidated:a.executionValidated,localOwnerValidated:a.localOwnerValidated===true,reasonCode:a.unavailableReason||null}))}),
    async localQuote(adapterId:string,reference:string) {
      const adapter=availableLocal(adapterId,"live");
      if(!adapter.quote) paymentError("local_owner_payment_contract_unverified",409);
      return validateQuote(await bounded(()=>adapter.quote!(reference),quoteMs));
    },
    async statusByRequestKey(requestKey:string) {
      if(!UUID.test(requestKey)) paymentError("invalid_payment_request");
      return options.store.change(rows=>{
        const r=rows.find(x=>x.draft.requestKey===requestKey);
        return r?paymentView(locate(rows,r.id)):null;
      });
    },
    async startLocalAuthorized(input:{confirmationRequestId:string;adapterId:string;reference:string;quote:PaymentQuote;preparationMs?:number}) {
      if(!UUID.test(input.confirmationRequestId)) paymentError("invalid_payment_request");
      if(!/^[a-z][a-z0-9_.-]{1,60}$/.test(input.adapterId)) paymentError("invalid_payment_request");
      if(!/^[A-Za-z0-9._-]{1,100}$/.test(input.reference)) paymentError("invalid_payment_request");
      const quote=validateQuote(input.quote);
      if(quote.reference!==input.reference) paymentError("invalid_payment_quote",502);
      const adapter=availableLocal(input.adapterId,"live");
      const started=now();
      const prepared:any=await options.store.change(rows=>{
        const existing=rows.find(r=>r.draft.requestKey===input.confirmationRequestId);
        if(existing) return {kind:"existing", view:paymentView(locate(rows, existing.id))};
        if(rows.some(r=>{
          normalize(r);
          return r.draft.mode==="live" &&
            r.draft.adapterId===input.adapterId &&
            r.quote.reference===quote.reference &&
            ["executing","effect_unknown","requires_bank_action","confirmed"].includes(r.state);
        })) paymentError("payment_for_reference_already_guarded",409);
        if(rows.length>=1000) paymentError("payment_registry_capacity_reached",409);
        const createdAt=now();
        const draft:PaymentDraft={
          requestKey:input.confirmationRequestId,
          adapterId:input.adapterId,
          reference:input.reference,
          mode:"live",
          origin:{channel:"samantha",id:"local-owner:"+input.confirmationRequestId}
        };
        const bankReturnToken=randomBytes(32).toString("base64url");
        const record:PaymentRecord={
          version:1,
          id:randomUUID(),
          draft,
          fingerprint:hash(JSON.stringify(draft)),
          quote,
          quoteHash:quoteDigest(input.adapterId,"live",quote),
          nonce:randomBytes(32).toString("hex"),
          keyId:options.key().id,
          createdAt,
          expiresAt:createdAt+120000,
          updatedAt:createdAt,
          state:"executing",
          reasonCode:"owner_confirmed_local",
          preparationMs:Math.max(0,input.preparationMs ?? (createdAt-started)),
          acceptedAt:createdAt,
          executionStartedAt:createdAt,
          executorAttempts:1,
          bankResumeAttempts:0,
          executionBootId:bootId,
          authorizationSource:"local_owner_confirmation",
          ownerConfirmationId:input.confirmationRequestId,
          bankReturnTokenHash:hash(bankReturnToken),
          trace:[
            {seq:1,at:createdAt,stage:"owner_confirmation_consumed"},
            {seq:2,at:createdAt,stage:"payment_record_created"},
            {seq:3,at:createdAt,stage:"financial_dispatch_committed"}
          ]
        };
        rows.push(record);
        return {kind:"created", record, bankReturnToken};
      });
      if(prepared.kind==="existing") return prepared.view;
      const {record,bankReturnToken}=prepared;
      const trace=async(event:PaymentTraceInput)=>options.store.change(rows=>{
        const current=locate(rows,record.id),at=now();
        if(current.state!=="executing")return;
        appendTrace(current,event,at);current.updatedAt=at;
      });
      try {
        const result:PaymentExecutionResult=await bounded(()=>adapter.executeLocal!(record.quote,record.id,{bankReturnToken,trace}),executionMs);
        return applyResult(record.id,"live",result);
      } catch {
        await trace({stage:"execution_error",reasonCode:"payment_effect_unverified"}).catch(()=>{});
        return finish(record.id,"effect_unknown","payment_effect_unverified");
      }
    },
    async prepare(input:any) {
      const draft=validateDraft(input),fingerprint=hash(JSON.stringify(draft)),started=now();
      const previous=(await options.store.read()).find(r=>r.draft.requestKey===draft.requestKey);
      if(previous) return options.store.change(rows=>{
        const r=locate(rows,previous.id);if(r.fingerprint!==fingerprint)paymentError("payment_request_key_conflict",409);return paymentView(r);
      });
      const adapter=availableExternal(draft.adapterId,draft.mode),key=options.key(),quote=validateQuote(await bounded(()=>adapter.quote!(draft.reference),quoteMs));
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
          state:"awaiting_owner",reasonCode:"owner_confirmation_required",preparationMs:Math.max(0,created-started),executorAttempts:0,bankResumeAttempts:0,authorizationSource:"payment_owner_native"};
        rows.push(r);return paymentView(r);
      });
    },
    async status(id:string) {return options.store.change(rows=>paymentView(locate(rows,id)));},
    async challenge(id:string) {
      return options.store.change(rows=>{
        const r=locate(rows,id);
        if(r.state!=="awaiting_owner")paymentError("payment_request_not_pending",409);
        availableForRecord(r);
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
        availableForRecord(r);
        const key=options.key();
        if(key.id!==r.keyId||proof.keyId!==r.keyId||proof.nonce!==r.nonce||proof.quoteHash!==r.quoteHash||
          !verify("sha256",Buffer.from(confirmationMessage(r),"utf8"),key.key,Buffer.from(proof.signature,"base64")))paymentError("invalid_owner_proof",403);
        r.acceptedAt=now();r.state="executing";r.reasonCode="owner_confirmed";r.executionBootId=bootId;r.updatedAt=now();
        return JSON.parse(JSON.stringify(r)) as PaymentRecord;
      });
      const adapter=availableForRecord(claimed);
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
        availableForRecord(r);
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
    async timeoutBankAction(id:string) {
      const claimed=await options.store.change(rows=>{
        const r=locate(rows,id);
        if(r.state!=="requires_bank_action"||r.executorAttempts!==1||r.bankResumeAttempts!==0||!r.continuation||
          !Number.isSafeInteger(r.bankActionRequiredAt)||now()-r.bankActionRequiredAt<BANK_ACTION_TIMEOUT_MS)
          paymentError("payment_bank_timeout_not_available",409);
        availableForRecord(r);
        const at=now();
        r.state="executing";r.reasonCode="bank_timeout_reconciling";r.executionBootId=bootId;r.updatedAt=at;
        delete r.bankReturnTokenHash;
        appendTrace(r,{stage:"bank_timeout_reconciliation_started"},at);
        return JSON.parse(JSON.stringify(r)) as PaymentRecord;
      });
      const adapter=availableForRecord(claimed);
      const traceSink={trace:async(event:PaymentTraceInput)=>options.store.change(rows=>{
        const current=locate(rows,id),at=now();if(current.state!=="executing")return;
        appendTrace(current,event,at);current.updatedAt=at;
      })};
      try {
        const fresh=validateQuote(await bounded(()=>adapter.quote!(claimed.quote.reference),quoteMs));
        if(quoteDigest(claimed.draft.adapterId,claimed.draft.mode,fresh)===claimed.quoteHash){
          await traceSink.trace({stage:"provider_readback",invoiceState:"unpaid"});
          return finish(id,"cancelled","payment_cancelled");
        }
      } catch {}
      const resumed=await options.store.change(rows=>{
        const r=locate(rows,id);
        if(r.state!=="executing"||r.bankResumeAttempts!==0||!r.continuation)paymentError("payment_resume_not_available",409);
        const at=now();r.bankResumeAttempts=1;r.resumedAt=at;r.updatedAt=at;
        appendTrace(r,{stage:"bank_resume_started",outcome:"timeout_reconciliation"},at);
        return JSON.parse(JSON.stringify(r)) as PaymentRecord;
      });
      try {
        const result:PaymentExecutionResult=await bounded(()=>adapter.resume!(resumed.quote,id,resumed.continuation,traceSink),executionMs);
        if(result?.state==="failed"&&result.rejectionVerified===true&&["payment_cancelled","session_expired"].includes(result.reasonCode))
          return finish(id,"cancelled","payment_cancelled");
        return applyResult(id,resumed.draft.mode,result);
      } catch {
        await traceSink.trace({stage:"execution_error",reasonCode:"payment_effect_unverified"}).catch(()=>{});
        return finish(id,"effect_unknown","payment_effect_unverified");
      }
    },
    async recordBankUiEvent(id:string,event:PaymentTraceInput) {
      if(!event||!BANK_UI_TRACE_STAGES.has(event.stage))paymentError("invalid_bank_ui_trace",400);
      return options.store.change(rows=>{
        const r=locate(rows,id);
        if(r.draft.mode!=="live"||r.executorAttempts!==1||
           !["executing","requires_bank_action","confirmed","failed","cancelled","blocked","effect_unknown"].includes(r.state))
          paymentError("payment_bank_ui_trace_not_available",409);
        const at=now();
        appendTrace(r,event,at,bankOriginsFor(r.draft.adapterId));
        r.updatedAt=at;
        return paymentView(r);
      });
    },
    async resume(id:string) {
      const claimed=await options.store.change(rows=>{
        const r=locate(rows,id);
        if(r.state!=="requires_bank_action"||r.executorAttempts!==1||r.bankResumeAttempts!==0)
          paymentError("payment_resume_not_available",409);
        const adapter=availableForRecord(r);
        if(typeof adapter.resume!=="function"||!r.continuation)paymentError("payment_resume_not_available",409);
        const at=now();
        r.state="executing";r.reasonCode="bank_action_resuming";r.executionBootId=bootId;
        r.bankResumeAttempts=1;r.resumedAt=at;delete r.bankReturnTokenHash;r.updatedAt=at;
        appendTrace(r,{stage:"bank_resume_started"},at);
        return JSON.parse(JSON.stringify(r)) as PaymentRecord;
      });
      const adapter=availableForRecord(claimed);
      const traceSink={trace:async(event:PaymentTraceInput)=>options.store.change(rows=>{
        const current=locate(rows,id),at=now();if(current.state!=="executing")return;
        appendTrace(current,event,at);current.updatedAt=at;
      })};
      try {
        const result:PaymentExecutionResult=await bounded(()=>adapter.resume!(claimed.quote,id,claimed.continuation,traceSink),executionMs);
        return applyResult(id,claimed.draft.mode,result);
      } catch {
        await traceSink.trace({stage:"execution_error",reasonCode:"payment_effect_unverified"}).catch(()=>{});
        return finish(id,"effect_unknown","payment_effect_unverified");
      }
    },
    async resumeFromBankReturn(id:string,bankReturnToken:string) {
      if(typeof bankReturnToken!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(bankReturnToken))paymentError("invalid_bank_return_token",403);
      const claimed=await options.store.change(rows=>{
        const r=locate(rows,id);
        if(r.state!=="requires_bank_action"||r.executorAttempts!==1||r.bankResumeAttempts!==0||!r.bankReturnTokenHash||
          hash(bankReturnToken)!==r.bankReturnTokenHash)paymentError("payment_bank_return_not_available",409);
        const adapter=availableForRecord(r);
        if(typeof adapter.resume!=="function"||!r.continuation)paymentError("payment_resume_not_available",409);
        const at=now();
        r.state="executing";r.reasonCode="bank_action_resuming";r.executionBootId=bootId;
        r.bankResumeAttempts=1;r.resumedAt=at;delete r.bankReturnTokenHash;r.updatedAt=at;
        appendTrace(r,{stage:"bank_resume_started"},at);
        return JSON.parse(JSON.stringify(r)) as PaymentRecord;
      });
      const adapter=availableForRecord(claimed);
      const traceSink={trace:async(event:PaymentTraceInput)=>options.store.change(rows=>{
        const current=locate(rows,id),at=now();if(current.state!=="executing")return;
        appendTrace(current,event,at);current.updatedAt=at;
      })};
      try {
        const result:PaymentExecutionResult=await bounded(()=>adapter.resume!(claimed.quote,id,claimed.continuation,traceSink),executionMs);
        return applyResult(id,claimed.draft.mode,result);
      } catch {
        await traceSink.trace({stage:"execution_error",reasonCode:"payment_effect_unverified"}).catch(()=>{});
        return finish(id,"effect_unknown","payment_effect_unverified");
      }
    }
  };
}
