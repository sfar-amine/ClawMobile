import fs from "fs";
import os from "os";
import path from "path";
import {createPaymentCore, ownerKey, paymentError} from "./paymentCore";
import {readPaymentRequests, mutatePaymentRequests} from "./runs";
import type {PaymentAdapter} from "./paymentTypes";

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
export const payments=createPaymentCore({store:{read:readPaymentRequests,change:mutatePaymentRequests},adapters,key});
