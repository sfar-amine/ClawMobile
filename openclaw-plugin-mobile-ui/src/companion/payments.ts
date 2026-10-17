import fs from "fs";
import os from "os";
import path from "path";
import {BANK_ACTION_TIMEOUT_MS, createPaymentCore, ownerKey, paymentError, validateQuote} from "./paymentCore";
import {readPaymentRequests, mutatePaymentRequests} from "./runs";
import type {PaymentAdapter,PaymentPayable,PaymentQuote} from "./paymentTypes";
import type {OwnerIntent, OwnerOrigin} from "./ownerConfirmationProtocol";
import {ownerHash, ownerUuid, ownerText} from "./ownerConfirmationProtocol";
import {confirmations} from "./confirmations";
import {createTopnetLivePaymentAdapter} from "./topnetLivePaymentAdapter";
import {createMaxitTopupLivePaymentAdapter} from "./maxitTopupLivePaymentAdapter";
import {LOCAL_PAYMENT_ACTION_TYPE, buildLocalPaymentIntent, localPaymentPayloadHash, parseLocalPaymentReference} from "./localPaymentIntent";
import {runTermuxCommand} from "../backends/termux";

// P1-5 nested budgets (11/10). Every layer waits longer than the layer it calls:
//   quote  : Python provider 40 s < adapter runner 43 s < PAYMENT_QUOTE_TIMEOUT_MS 45 s < CLI HTTP 50 s
//   start  : adapter runner 220 s < PAYMENT_EXECUTION_TIMEOUT_MS 230 s;
//            route /payments/local-start = quote + execution = LOCAL_START_ROUTE_BUDGET_MS < Android call
//   resume : Python status 40 s < adapter runner 60 s < PAYMENT_RESUME_TIMEOUT_MS 65 s < Android bank-return call
export const PAYMENT_QUOTE_TIMEOUT_MS=45_000;
export const PAYMENT_EXECUTION_TIMEOUT_MS=230_000;
export const PAYMENT_RESUME_TIMEOUT_MS=65_000;
export const LOCAL_START_ROUTE_BUDGET_MS=PAYMENT_QUOTE_TIMEOUT_MS+PAYMENT_EXECUTION_TIMEOUT_MS;
export {BANK_ACTION_TIMEOUT_MS};

const adapters:PaymentAdapter[]=[
  {id:"demo.confirmation",label:"Test de confirmation — aucun paiement",mode:"demo",executionValidated:true,
    async quote(reference){if(reference!=="DEMO")paymentError("invalid_demo_reference");return {payee:"Test sans paiement",reference,amountMinor:0,currency:"TND",decimals:3};},
    async revalidate(q){return {...q};},async execute(){return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed"};}},
  createTopnetLivePaymentAdapter(),
  createMaxitTopupLivePaymentAdapter(),
  ...["steg","sonede"].map(id=>({id,label:id.toUpperCase(),mode:"live" as const,executionValidated:false,unavailableReason:"provider_payment_contract_unverified"}))
];

function key() {
  const state=process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),".openclaw");
  try {return ownerKey(fs.readFileSync(path.join(state,"clawmobile-companion","owner-confirmation-public.pem")));}
  catch {return paymentError("owner_key_not_provisioned",503);}
}

export function bankAuthorizationIntent(payment:any):OwnerIntent {
  if(!payment||payment.state!=="requires_bank_action"||!payment.quote||!payment.origin)
    paymentError("payment_resume_not_available",409);
  const q=payment.quote;
  if(!Number.isSafeInteger(q.amountMinor)||!Number.isInteger(q.decimals)||q.decimals<0||q.decimals>3)
    paymentError("payment_record_invalid",503);
  const factor=10**q.decimals;
  const fee=q.feeMinor!==undefined;
  if(fee&&(!Number.isSafeInteger(q.totalMinor)||q.totalMinor!==q.amountMinor+q.feeMinor))paymentError("payment_record_invalid",503);
  // With a provider fee the bank step names the total debited, not the top-up amount alone.
  const amount=((fee?q.totalMinor:q.amountMinor)/factor).toFixed(q.decimals);
  const payloadHash=ownerHash([fee?"claw.payment.bank.v2":"claw.payment.bank.v1",payment.requestId,payment.adapterId,payment.mode,
    q.payee,q.reference,q.amountMinor,...(fee?[q.feeMinor,q.totalMinor,q.feeLabel]:[]),q.currency,q.decimals].join("\n"));
  return {audience:"confirmation",
    action:{type:"payment.bank_2fa",reference:payment.requestId,payloadHash},
    presentation:{title:"Autoriser l’authentification bancaire",subtitle:`${q.payee} — ${amount} ${q.currency}`,
      description:`Continuer la transaction ${q.reference}. Le code bancaire reste local à ce téléphone.`},
    origin:payment.origin};
}

export function bindPaymentAuthorizations(core:any,confirmationCore:any) {
  return {
    ...core,
    async bankAuthorization(id:string) {
      const payment=await core.status(id),intent=bankAuthorizationIntent(payment);
      const prepared=await confirmationCore.prepare({requestKey:id,action:intent.action,presentation:intent.presentation,origin:intent.origin});
      return {schemaVersion:1,requestId:id,state:payment.state,confirmationRequestId:prepared.requestId,
        confirmationState:prepared.state,expiresAt:prepared.expiresAt};
    },
    async resume(id:string,confirmationRequestId:string) {
      const payment=await core.status(id),intent=bankAuthorizationIntent(payment);
      if(typeof confirmationRequestId!=="string")paymentError("invalid_payment_resume_request");
      await confirmationCore.consume(confirmationRequestId,intent);
      return core.resume(id);
    },
    async bankReturn(id:string,bankReturnToken:string) {
      return core.resumeFromBankReturn(id,bankReturnToken);
    }
  };
}

function exactPaymentObject(v:any,keys:string[]) {
  if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(v,k))) paymentError("invalid_payment_request");
}

function validateOrigin(v:any):OwnerOrigin {
  exactPaymentObject(v,["channel","id"]);
  if(!["chatgpt","work","claw","samantha"].includes(v.channel)||!ownerText(v.id,120)) paymentError("invalid_payment_request");
  return {channel:v.channel,id:v.id};
}

export function validateLocalHandoffInput(v:any):{requestKey:string;adapterId:string;quote:PaymentQuote;origin:OwnerOrigin;notify:boolean} {
  exactPaymentObject(v,["requestKey","adapterId","quote","origin","notify"]);
  if(typeof v.requestKey!=="string"||!ownerUuid.test(v.requestKey)||typeof v.adapterId!=="string"||!/^[a-z][a-z0-9_.-]{1,60}$/.test(v.adapterId)||typeof v.notify!=="boolean")
    paymentError("invalid_payment_request");
  const adapter=adapters.find(a=>a.id===v.adapterId);
  if(!adapter||adapter.mode!=="live"||adapter.localOwnerValidated!==true) paymentError("local_owner_payment_contract_unverified",409);
  const quote=validateQuote(v.quote);
  if(!/^[A-Za-z0-9._-]{1,100}$/.test(quote.reference))paymentError("invalid_payment_quote",502);
  return {requestKey:v.requestKey,adapterId:v.adapterId,quote,origin:validateOrigin(v.origin),notify:v.notify};
}

function formatPayableAmount(q:PaymentQuote){
  // Total debited when a provider fee applies (Maxit), otherwise the amount.
  const value=q.feeMinor!==undefined&&Number.isSafeInteger(q.totalMinor)?q.totalMinor!:q.amountMinor;
  const scale=10**q.decimals,whole=Math.floor(value/scale),frac=value%scale;
  return q.decimals?String(whole)+","+String(frac).padStart(q.decimals,"0"):String(whole);
}

export function localHandoffNotificationArgs(confirmationRequestId:string,quote:PaymentQuote){
  if(!ownerUuid.test(confirmationRequestId))paymentError("invalid_payment_request");
  const id=String(parseInt(confirmationRequestId.slice(0,8),16)%2000000000);
  return ["--id",id,"--title","Samantha · Paiement","--content",`${quote.payee} · ${formatPayableAmount(quote)} ${quote.currency}`];
}
async function notifyLocalHandoff(confirmationRequestId:string,quote:PaymentQuote){
  const res=await runTermuxCommand("termux-notification",localHandoffNotificationArgs(confirmationRequestId,quote),5000);
  return res.ok;
}

const UI_PROGRESS_STAGES=new Set([
  "owner_confirmation_consumed","payment_record_created","financial_dispatch_committed",
  "provider_session_started","provider_session_authenticated","invoice_revalidated",
  "checkout_prepared","browser_context_ready","three_ds2_preflight",
  "gateway_submission_started","gateway_submission_result","bank_ui_opened",
  "bank_resume_started","provider_readback","provider_callback_correlated",
  "completion_classified","state_transition"
]);
function latestUiProgress(payment:any){
  const timeline=Array.isArray(payment?.timeline)?payment.timeline:[];
  for(let i=timeline.length-1;i>=0;i--){
    const e=timeline[i];
    if(e&&UI_PROGRESS_STAGES.has(e.stage))return {
      stage:e.stage,
      ...(typeof e.outcome==="string"?{outcome:e.outcome}:{}),
      ...(typeof e.invoiceState==="string"?{invoiceState:e.invoiceState}:{}),
      ...(Number.isSafeInteger(e.at)?{at:e.at}:{})
    };
  }
  return null;
}
const SAFE_CODE=/^[a-z0-9_]{1,96}$/;
/** Last traced step carrying a reason (P0-8): the app renders it as readable text, never raw. */
export function latestPaymentStep(payment:any){
  const timeline=Array.isArray(payment?.timeline)?payment.timeline:[];
  for(let i=timeline.length-1;i>=0;i--){
    const e=timeline[i];
    if(!e||typeof e.stage!=="string"||e.stage==="http_exchange"||e.stage.startsWith("bank_ui")||e.stage.startsWith("bank_return"))continue;
    if(typeof e.reasonCode!=="string"&&typeof e.reasonDetail!=="string"&&e.stage!=="state_transition")continue;
    // The state transition only groups; prefer the precise execution_error just before it.
    const prior=timeline.slice(0,i).reverse().find((x:any)=>x?.stage==="execution_error"&&typeof x.reasonDetail==="string");
    const detail=typeof e.reasonDetail==="string"?e.reasonDetail:prior?.reasonDetail;
    return {
      stage:e.stage==="state_transition"&&prior?prior.stage:e.stage,
      ...(typeof e.reasonCode==="string"&&SAFE_CODE.test(e.reasonCode)?{reasonCode:e.reasonCode}:{}),
      ...(typeof detail==="string"&&SAFE_CODE.test(detail)?{reasonDetail:detail}:{})
    };
  }
  return null;
}
function safeStepError(error:any){
  const code=String(error?.message??"");
  return SAFE_CODE.test(code)?code:"payment_step_failed";
}
async function recordConfirmationStep(id:string,stage:string,reasonCode?:string,outcome?:string){
  // Best effort: the receipt must never turn a no-effect refusal into a different error.
  try{await confirmations.recordStep(id,{stage,...(reasonCode?{reasonCode}:{}),...(outcome?{outcome}:{})});}catch{}
}
export function compactPaymentUiView(payment:any){
  if(!payment||payment.schemaVersion!==1||typeof payment.requestId!=="string")paymentError("invalid_payment_response",503);
  return {
    schemaVersion:1,
    requestId:payment.requestId,
    adapterId:payment.adapterId,
    state:payment.state,
    reasonCode:payment.reasonCode,
    quote:payment.quote,
    financialSubmissionAttempted:payment.financialSubmissionAttempted===true,
    progress:latestUiProgress(payment),
    lastStep:latestPaymentStep(payment),
    ...(Number.isSafeInteger(payment.bankActionDeadlineAt)
      ?{bankActionDeadlineAt:payment.bankActionDeadlineAt,bankActionTimeoutMs:payment.bankActionTimeoutMs}:{}),
    ...(payment.receipt?{receipt:payment.receipt}:{})
  };
}

function validateLocalIntentInput(v:any):{requestKey:string;adapterId:string;reference:string;origin:OwnerOrigin} {
  exactPaymentObject(v,["requestKey","adapterId","reference","origin"]);
  if(typeof v.requestKey!=="string"||!ownerUuid.test(v.requestKey)) paymentError("invalid_payment_request");
  if(typeof v.adapterId!=="string"||!/^[a-z][a-z0-9_.-]{1,60}$/.test(v.adapterId)) paymentError("invalid_payment_request");
  if(typeof v.reference!=="string"||!/^[A-Za-z0-9._-]{1,100}$/.test(v.reference)) paymentError("invalid_payment_request");
  return {requestKey:v.requestKey,adapterId:v.adapterId,reference:v.reference,origin:validateOrigin(v.origin)};
}

const core=createPaymentCore({store:{read:readPaymentRequests,change:mutatePaymentRequests},adapters,key,
  timeouts:{quoteMs:PAYMENT_QUOTE_TIMEOUT_MS,executionMs:PAYMENT_EXECUTION_TIMEOUT_MS,resumeMs:PAYMENT_RESUME_TIMEOUT_MS}});
const bankTimeoutTimers=new Map<string,ReturnType<typeof setTimeout>>();
function clearBankTimeout(id:string){
  const timer=bankTimeoutTimers.get(id);
  if(timer)clearTimeout(timer);
  bankTimeoutTimers.delete(id);
}
async function bankTimeoutDueAt(id:string){
  const rows=await readPaymentRequests();
  const r=rows.find(x=>x.id===id);
  if(!r||r.state!=="requires_bank_action"||r.executorAttempts!==1||(r.bankResumeAttempts??0)!==0||
    !Number.isSafeInteger(r.bankActionRequiredAt))return null;
  return r.bankActionRequiredAt!+BANK_ACTION_TIMEOUT_MS;
}
async function scheduleBankTimeout(id:string){
  clearBankTimeout(id);
  const due=await bankTimeoutDueAt(id);
  if(due===null)return false;
  const delay=Math.max(0,due-Date.now())+25;
  const timer=setTimeout(()=>{
    bankTimeoutTimers.delete(id);
    void core.timeoutBankAction(id).catch(()=>{});
  },delay);
  timer.unref();bankTimeoutTimers.set(id,timer);return true;
}
async function startBankTimeoutReconciler(){
  const rows=await readPaymentRequests();let scheduled=0;
  for(const r of rows){
    if(r.state==="requires_bank_action"&&r.executorAttempts===1&&(r.bankResumeAttempts??0)===0&&Number.isSafeInteger(r.bankActionRequiredAt)){
      if(await scheduleBankTimeout(r.id))scheduled++;
    }
  }
  return {scheduled,timeoutMs:BANK_ACTION_TIMEOUT_MS};
}
const bound=bindPaymentAuthorizations(core, confirmations);

async function listPayables(adapterId?:string){
  if(adapterId!==undefined&&(!/^[a-z][a-z0-9_.-]{1,60}$/.test(adapterId)))paymentError("invalid_payment_request");
  const targets=adapters.filter(a=>a.mode==="live"&&a.localOwnerValidated===true&&typeof a.listPayables==="function"&&(!adapterId||a.id===adapterId));
  if(adapterId&&targets.length!==1)paymentError("local_owner_payment_contract_unverified",409);
  const settled=await Promise.all(targets.map(async adapter=>{
    try{return {adapter,quotes:await adapter.listPayables!(),error:null};}catch{return {adapter,quotes:[] as PaymentQuote[],error:"provider_read_unavailable"};}
  }));
  const items:PaymentPayable[]=settled.flatMap(({adapter,quotes})=>quotes.map(q=>({adapterId:adapter.id,...validateQuote(q)})));
  return {schemaVersion:1,items,providers:settled.map(x=>({adapterId:x.adapter.id,state:x.error?"unavailable":"ok",count:x.quotes.length,reasonCode:x.error}))};
}

async function prepareLocalHandoff(input:any){
  const v=validateLocalHandoffInput(input);
  const intent=buildLocalPaymentIntent({adapterId:v.adapterId,quote:v.quote,origin:v.origin});
  const prepared=await confirmations.prepare({requestKey:v.requestKey,action:intent.action,presentation:intent.presentation,origin:intent.origin});
  await recordConfirmationStep(prepared.requestId,"handoff_prepared",undefined,"awaiting_owner");
  const notificationSent=v.notify?await notifyLocalHandoff(prepared.requestId,v.quote):false;
  return {schemaVersion:1,state:"awaiting_owner",confirmationRequestId:prepared.requestId,quote:v.quote,expiresAt:prepared.expiresAt,notificationSent};
}

async function prepareLocalIntent(input:any) {
  const v=validateLocalIntentInput(input);
  const quote=await core.localQuote(v.adapterId, v.reference);
  if(quote.reference!==v.reference) paymentError("invalid_payment_quote",502);
  const intent=buildLocalPaymentIntent({adapterId:v.adapterId, quote, origin:v.origin});
  const prepared=await confirmations.prepare({requestKey:v.requestKey, action:intent.action, presentation:intent.presentation, origin:intent.origin});
  return {schemaVersion:1, state:"awaiting_owner", confirmationRequestId:prepared.requestId, quote, expiresAt:prepared.expiresAt};
}

async function localIntentStatus(id:string) {
  if(typeof id!=="string"||!ownerUuid.test(id)) paymentError("invalid_payment_request");
  const payment=await core.statusByRequestKey(id);
  if(payment) return {
    schemaVersion:1, confirmationRequestId:id, state:payment.state,
    financialSubmissionAttempted:payment.financialSubmissionAttempted,
    payment:compactPaymentUiView(payment)
  };
  const confirmation=await confirmations.status(id);
  const lastStep=await confirmations.lastStep(id).catch(()=>null);
  return {schemaVersion:1, confirmationRequestId:id, state:confirmation.state,
    financialSubmissionAttempted:false, ...(lastStep?{lastStep:{stage:lastStep.stage,
      ...(lastStep.reasonCode?{reasonCode:lastStep.reasonCode}:{})}}:{})};
}

async function localStart(input:any) {
  exactPaymentObject(input,["confirmationRequestId"]);
  if(typeof input.confirmationRequestId!=="string"||!ownerUuid.test(input.confirmationRequestId)) paymentError("invalid_payment_request");
  const id=input.confirmationRequestId;

  const existing=await core.statusByRequestKey(id);
  if(existing) return compactPaymentUiView(existing);

  const conf=await confirmations.status(id);
  const refuse=async(stage:string,code:string,status:number):Promise<never>=>{
    await recordConfirmationStep(id,stage,code);
    return paymentError(code,status);
  };

  if(conf.state==="consumed") await refuse("owner_confirmation","local_payment_start_interrupted_before_dispatch",409);
  if(conf.state==="expired") await refuse("owner_confirmation","local_start_confirmation_expired",409);
  if(conf.state!=="approved") await refuse("owner_confirmation","local_start_confirmation_not_approved",409);
  if(conf.intent.action.type!==LOCAL_PAYMENT_ACTION_TYPE) await refuse("owner_confirmation","local_start_action_type_mismatch",409);

  let parsedRef:{adapterId:string; providerReference:string};
  try {
    parsedRef=parseLocalPaymentReference(conf.intent.action.reference);
  } catch {
    return refuse("owner_confirmation","local_payment_reference_invalid",400);
  }

  let freshQuote:PaymentQuote;
  try {freshQuote=await core.localQuote(parsedRef.adapterId, parsedRef.providerReference);}
  catch(error:any) {return refuse("quote_revalidation",safeStepError(error),Number(error?.statusCode)||502);}
  if(freshQuote.reference!==parsedRef.providerReference) await refuse("quote_revalidation","invalid_payment_quote",502);
  if(conf.intent.action.payloadHash!==localPaymentPayloadHash(parsedRef.adapterId, freshQuote)) await refuse("quote_revalidation","payment_quote_changed",409);

  const expectedIntent=buildLocalPaymentIntent({
    adapterId:parsedRef.adapterId,
    quote:freshQuote,
    origin:{channel:conf.intent.origin.channel,id:conf.intent.origin.id}
  });

  try {await confirmations.consume(id, expectedIntent);}
  catch(error:any) {return refuse("confirmation_consume",safeStepError(error),Number(error?.statusCode)||409);}
  await recordConfirmationStep(id,"payment_dispatch",undefined,"payment_record_created");
  const result=await core.startLocalAuthorized({
    confirmationRequestId:id,
    adapterId:parsedRef.adapterId,
    reference:parsedRef.providerReference,
    quote:freshQuote
  });
  if(result.state==="requires_bank_action")await scheduleBankTimeout(result.requestId);
  return compactPaymentUiView(result);
}

async function bankUiEvent(id:string,event:any){
  return compactPaymentUiView(await core.recordBankUiEvent(id,event));
}
async function bankReturn(id:string,bankReturnToken:string){
  const result=await bound.bankReturn(id,bankReturnToken);
  clearBankTimeout(id);
  return compactPaymentUiView(result);
}
async function resume(id:string,confirmationRequestId:string){
  const result=await bound.resume(id,confirmationRequestId);
  clearBankTimeout(id);
  return compactPaymentUiView(result);
}

async function statusCompact(id:string){
  return compactPaymentUiView(await core.status(id));
}

export const payments = {
  ...bound,
  statusCompact,
  resume,
  bankReturn,
  bankUiEvent,
  listPayables,
  prepareLocalHandoff,
  prepareLocalIntent,
  localIntentStatus,
  localStart,
  startBankTimeoutReconciler
};
