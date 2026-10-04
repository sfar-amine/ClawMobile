import {createHash} from "crypto";
import type {PaymentQuote} from "./paymentTypes";
import type {OwnerIntent, OwnerOrigin} from "./ownerConfirmationProtocol";

export const LOCAL_PAYMENT_ACTION_TYPE = "payment.local_start";
export const LOCAL_PAYMENT_INTENT_DOMAIN = "claw.payment.local-start.v1";

const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");

function formatAmount(amountMinor:number, decimals:number):string {
  if(!Number.isSafeInteger(amountMinor)||amountMinor<0) throw new Error("invalid_payment_quote");
  if(!Number.isInteger(decimals)||decimals<0||decimals>3) throw new Error("invalid_payment_quote");
  const scale=10**decimals;
  const whole=Math.floor(amountMinor/scale);
  const frac=amountMinor%scale;
  if(decimals===0) return String(whole);
  return String(whole)+","+String(frac).padStart(decimals,"0");
}

export function localPaymentPayloadHash(adapterId:string, quote:PaymentQuote):string {
  return hash([
    LOCAL_PAYMENT_INTENT_DOMAIN,
    adapterId,
    quote.payee,
    quote.reference,
    String(quote.amountMinor),
    quote.currency,
    String(quote.decimals)
  ].join("\n"));
}

export function buildLocalPaymentIntent(args:{
  adapterId:string;
  quote:PaymentQuote;
  origin:OwnerOrigin;
}):OwnerIntent {
  const {adapterId, quote, origin}=args;
  const amount=formatAmount(quote.amountMinor, quote.decimals);
  return {
    audience:"confirmation",
    action:{
      type:LOCAL_PAYMENT_ACTION_TYPE,
      reference:adapterId+":"+quote.reference,
      payloadHash:localPaymentPayloadHash(adapterId, quote)
    },
    presentation:{
      title:"Autoriser le paiement",
      subtitle:amount+" "+quote.currency+" à "+quote.payee,
      description:"Facture "+quote.reference+". Le paiement sera créé et envoyé uniquement après cette biométrie."
    },
    origin
  };
}

export function parseLocalPaymentReference(reference:string):{adapterId:string; providerReference:string} {
  const m=/^([a-z][a-z0-9_.-]{1,60}):([A-Za-z0-9._-]{1,100})$/.exec(reference);
  if(!m) {
    throw Object.assign(new Error("invalid_local_payment_reference"), {statusCode:400});
  }
  return {adapterId:m[1], providerReference:m[2]};
}
