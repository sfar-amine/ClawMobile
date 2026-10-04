export type PaymentQuote = {payee:string; reference:string; amountMinor:number; currency:string; decimals:number};
export type PaymentOrigin = {channel:"chatgpt"|"work"|"claw"|"samantha"; id:string};
export type PaymentDraft = {requestKey:string; adapterId:string; reference:string; mode:"demo"|"live"; origin:PaymentOrigin};
export type PaymentState = "awaiting_owner"|"executing"|"demo_confirmed"|"confirmed"|"failed"|"cancelled"|"expired"|"blocked"|"effect_unknown"|"requires_bank_action";
export type PaymentContinuation = {provider:string; checkoutId:string; gatewayOrderId:string};
export type PaymentExecutionContext = {bankReturnToken:string};
export type PaymentAuthorizationSource = "payment_owner_native" | "local_owner_confirmation";

export type PaymentRecord = {
  version:1; id:string; draft:PaymentDraft; fingerprint:string; quote:PaymentQuote;
  quoteHash:string; nonce:string; keyId:string; createdAt:number; expiresAt:number;
  updatedAt:number; state:PaymentState; reasonCode:string; preparationMs:number;
  acceptedAt?:number; executionStartedAt?:number; bankActionRequiredAt?:number; resumedAt?:number; endedAt?:number;
  executorAttempts:number; bankResumeAttempts?:number; executionBootId?:string; continuation?:PaymentContinuation; bankReturnTokenHash?:string;
  authorizationSource:PaymentAuthorizationSource;
  ownerConfirmationId?:string;
  receipt?:{reference:string; transactionCorrelated:true; providerReconciled:true};
};

export type PaymentExecutionResult = {
  state:"confirmed"|"failed"|"effect_unknown"|"requires_bank_action"; reasonCode:string; rejectionVerified?:true;
  continuation?:PaymentContinuation;
  receipt?:{reference:string; transactionCorrelated:true; providerReconciled:true};
};

export type PaymentAdapter = {
  id:string; label:string; mode:"demo"|"live"; executionValidated:boolean; localOwnerValidated?:boolean; unavailableReason?:string;
  quote?:(reference:string)=>Promise<PaymentQuote>;
  revalidate?:(quote:PaymentQuote)=>Promise<PaymentQuote>;
  execute?:(quote:PaymentQuote,requestId:string,context?:PaymentExecutionContext)=>Promise<PaymentExecutionResult>;
  executeLocal?:(quote:PaymentQuote,requestId:string,context?:PaymentExecutionContext)=>Promise<PaymentExecutionResult>;
  resume?:(quote:PaymentQuote,requestId:string,continuation?:PaymentContinuation)=>Promise<PaymentExecutionResult>;
};

export interface PaymentStore {
  read():Promise<PaymentRecord[]>;
  change<T>(operation:(records:PaymentRecord[])=>T):Promise<T>;
}
