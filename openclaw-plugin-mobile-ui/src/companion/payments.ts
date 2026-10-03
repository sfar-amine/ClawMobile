import fs from "fs";
import os from "os";
import path from "path";
import {createPaymentCore, ownerKey, paymentError} from "./paymentCore";
import {readPaymentRequests, mutatePaymentRequests} from "./runs";
import type {PaymentAdapter} from "./paymentTypes";
import type {OwnerIntent} from "./ownerConfirmationProtocol";
import {ownerHash} from "./ownerConfirmationProtocol";
import {confirmations} from "./confirmations";

// No real executor is registered until its complete bank/result contract is validated.
const adapters:PaymentAdapter[]=[
 {id:"demo.confirmation",label:"Test de confirmation — aucun paiement",mode:"demo",executionValidated:true,
  async quote(reference){if(reference!=="DEMO")paymentError("invalid_demo_reference");return {payee:"Test sans paiement",reference,amountMinor:0,currency:"TND",decimals:3};},
  async revalidate(q){return {...q};},async execute(){return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed"};}},
 ...["topnet","steg","sonede"].map(id=>({id,label:id.toUpperCase(),mode:"live" as const,executionValidated:false,unavailableReason:"provider_payment_contract_unverified"}))
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
  }
 };
}

const core=createPaymentCore({store:{read:readPaymentRequests,change:mutatePaymentRequests},adapters,key,timeouts:{executionMs:65000}});
export const payments=bindPaymentAuthorizations(core,confirmations);
