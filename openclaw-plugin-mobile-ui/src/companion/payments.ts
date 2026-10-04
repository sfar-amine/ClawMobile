import fs from "fs";
import os from "os";
import path from "path";
import {BANK_ACTION_TIMEOUT_MS, createPaymentCore, ownerKey, paymentError} from "./paymentCore";
import {readPaymentRequests, mutatePaymentRequests} from "./runs";
import type {PaymentAdapter} from "./paymentTypes";
import type {OwnerIntent, OwnerOrigin} from "./ownerConfirmationProtocol";
import {ownerHash, ownerUuid, ownerText} from "./ownerConfirmationProtocol";
import {confirmations} from "./confirmations";
import {createTopnetLivePaymentAdapter} from "./topnetLivePaymentAdapter";
import {LOCAL_PAYMENT_ACTION_TYPE, buildLocalPaymentIntent, localPaymentPayloadHash, parseLocalPaymentReference} from "./localPaymentIntent";

const adapters:PaymentAdapter[]=[
  {id:"demo.confirmation",label:"Test de confirmation — aucun paiement",mode:"demo",executionValidated:true,
    async quote(reference){if(reference!=="DEMO")paymentError("invalid_demo_reference");return {payee:"Test sans paiement",reference,amountMinor:0,currency:"TND",decimals:3};},
    async revalidate(q){return {...q};},async execute(){return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed"};}},
  createTopnetLivePaymentAdapter(),
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
  const amount=(q.amountMinor/factor).toFixed(q.decimals);
  const payloadHash=ownerHash(["claw.payment.bank.v1",payment.requestId,payment.adapterId,payment.mode,
    q.payee,q.reference,q.amountMinor,q.currency,q.decimals].join("\n"));
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

function validateLocalIntentInput(v:any):{requestKey:string;adapterId:string;reference:string;origin:OwnerOrigin} {
  exactPaymentObject(v,["requestKey","adapterId","reference","origin"]);
  if(typeof v.requestKey!=="string"||!ownerUuid.test(v.requestKey)) paymentError("invalid_payment_request");
  if(typeof v.adapterId!=="string"||!/^[a-z][a-z0-9_.-]{1,60}$/.test(v.adapterId)) paymentError("invalid_payment_request");
  if(typeof v.reference!=="string"||!/^[A-Za-z0-9._-]{1,100}$/.test(v.reference)) paymentError("invalid_payment_request");
  exactPaymentObject(v.origin,["channel","id"]);
  if(!["chatgpt","work","claw","samantha"].includes(v.origin.channel)||!ownerText(v.origin.id,120)) paymentError("invalid_payment_request");
  return {requestKey:v.requestKey,adapterId:v.adapterId,reference:v.reference,origin:{channel:v.origin.channel,id:v.origin.id}};
}

const core=createPaymentCore({store:{read:readPaymentRequests,change:mutatePaymentRequests},adapters,key,timeouts:{executionMs:225000}});
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
    financialSubmissionAttempted:payment.financialSubmissionAttempted, payment
  };
  const confirmation=await confirmations.status(id);
  return {schemaVersion:1, confirmationRequestId:id, state:confirmation.state,
    financialSubmissionAttempted:false};
}

async function localStart(input:any) {
  exactPaymentObject(input,["confirmationRequestId"]);
  if(typeof input.confirmationRequestId!=="string"||!ownerUuid.test(input.confirmationRequestId)) paymentError("invalid_payment_request");
  const id=input.confirmationRequestId;

  const existing=await core.statusByRequestKey(id);
  if(existing) return existing;

  const conf=await confirmations.status(id);

  if(conf.state==="consumed") paymentError("local_payment_start_interrupted_before_dispatch",409);
  if(conf.state==="expired") paymentError("local_start_confirmation_expired",409);
  if(conf.state!=="approved") paymentError("local_start_confirmation_not_approved",409);
  if(conf.intent.action.type!==LOCAL_PAYMENT_ACTION_TYPE) paymentError("local_start_action_type_mismatch",409);

  let parsedRef:{adapterId:string; providerReference:string};
  try {
    parsedRef=parseLocalPaymentReference(conf.intent.action.reference);
  } catch {
    paymentError("local_payment_reference_invalid",400);
  }

  const freshQuote=await core.localQuote(parsedRef.adapterId, parsedRef.providerReference);
  if(freshQuote.reference!==parsedRef.providerReference) paymentError("invalid_payment_quote",502);
  if(conf.intent.action.payloadHash!==localPaymentPayloadHash(parsedRef.adapterId, freshQuote)) paymentError("payment_quote_changed",409);

  const expectedIntent=buildLocalPaymentIntent({
    adapterId:parsedRef.adapterId,
    quote:freshQuote,
    origin:{channel:conf.intent.origin.channel,id:conf.intent.origin.id}
  });

  await confirmations.consume(id, expectedIntent);
  const result=await core.startLocalAuthorized({
    confirmationRequestId:id,
    adapterId:parsedRef.adapterId,
    reference:parsedRef.providerReference,
    quote:freshQuote
  });
  if(result.state==="requires_bank_action")await scheduleBankTimeout(result.requestId);
  return result;
}

async function bankReturn(id:string,bankReturnToken:string){
  const result=await bound.bankReturn(id,bankReturnToken);
  clearBankTimeout(id);
  return result;
}
async function resume(id:string,confirmationRequestId:string){
  const result=await bound.resume(id,confirmationRequestId);
  clearBankTimeout(id);
  return result;
}

export const payments = {
  ...bound,
  resume,
  bankReturn,
  prepareLocalIntent,
  localIntentStatus,
  localStart,
  startBankTimeoutReconciler
};
