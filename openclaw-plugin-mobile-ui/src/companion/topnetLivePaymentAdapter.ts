import {createClicToPayLivePaymentAdapter,type ClicToPayLivePaymentAdapterOptions} from "./clicToPayLivePaymentAdapter";

const TOPNET_INVOICE=/^[A-Za-z0-9._-]{1,100}$/;

export function createTopnetLivePaymentAdapter(options:ClicToPayLivePaymentAdapterOptions={}) {
  return createClicToPayLivePaymentAdapter({
    id:"topnet",label:"TOPNET",payee:"TOPNET",referencePattern:TOPNET_INVOICE,
    executionValidated:false,localOwnerValidated:true,unavailableReason:"provider_payment_contract_unverified",
    bankNavigationOrigins:["https://3ds2.clictopay.com","https://ipay.clictopay.com","https://www.topnet.tn"],
    acceptanceGate:{filename:"topnet-live-acceptance.enabled",value:"topnet-v1-live-acceptance"},
    receiptPrefix:"internal-topnet-"
  },options);
}
