import {createClicToPayLivePaymentAdapter,type ClicToPayLivePaymentAdapterOptions} from "./clicToPayLivePaymentAdapter";

// SONEDE invoice id (idBase): digits only, observed 06/11/2026 on portail.sonede.com.tn.
const SONEDE_INVOICE=/^[0-9]{1,12}$/;

// Off by default: offered and executable only while the one-shot marker
// clawmobile-companion/sonede-live-acceptance.enabled holds exactly "sonede-v1-live-acceptance".
// Each execution consumes it, owner-confirmed local path included; no marker = nothing sent.
export function createSonedeLivePaymentAdapter(options:ClicToPayLivePaymentAdapterOptions={}) {
  return createClicToPayLivePaymentAdapter({
    id:"sonede",label:"SONEDE",payee:"SONEDE",referencePattern:SONEDE_INVOICE,
    executionValidated:false,localRequiresGate:true,unavailableReason:"provider_payment_contract_unverified",
    bankNavigationOrigins:["https://3ds2.clictopay.com","https://ipay.clictopay.com","https://portail.sonede.com.tn"],
    acceptanceGate:{filename:"sonede-live-acceptance.enabled",value:"sonede-v1-live-acceptance"},
    receiptPrefix:"internal-sonede-"
  },options);
}
