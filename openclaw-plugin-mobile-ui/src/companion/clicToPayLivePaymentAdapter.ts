import fs from "fs";
import os from "os";
import path from "path";
import {execFile, spawn} from "child_process";
import type {PaymentAdapter,PaymentContinuation,PaymentExecutionContext,PaymentExecutionResult,PaymentQuote,PaymentTraceSink} from "./paymentTypes";

type ExecResult={stdout:string;stderr:string};
type ExecFn=(file:string,args:string[],timeoutMs:number)=>Promise<ExecResult>;
type LiveRunFn=(script:string,payload:Record<string,unknown>,timeoutMs:number,onEvent?:(event:any)=>Promise<void>|void)=>Promise<any>;

const MAX=65536;
const LIVE_MAX=524288;
const FORENSIC_SNAPSHOT_MAX=65536;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const START_TIMEOUT_MS=225000;
const RESUME_TIMEOUT_MS=45000;

function runExec(file:string,args:string[],timeoutMs:number):Promise<ExecResult>{
  return new Promise((resolve,reject)=>{
    execFile(file,args,{timeout:timeoutMs,maxBuffer:MAX,encoding:"utf8"},(error,stdout,stderr)=>{
      if(error)return reject(new Error("billing_adapter_unavailable"));
      resolve({stdout,stderr});
    });
  });
}

function runLive(script:string,payload:Record<string,unknown>,timeoutMs:number,onEvent?:(event:any)=>Promise<void>|void):Promise<any>{
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script],{stdio:["pipe","pipe","ignore"]});
    let buffer="",final:any=null,settled=false,eventWrites=Promise.resolve();
    const timer=setTimeout(()=>{if(!settled){settled=true;child.kill("SIGKILL");reject(new Error("payment_live_timeout"));}},timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",(chunk:string)=>{
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>LIVE_MAX){if(!settled){settled=true;clearTimeout(timer);child.kill("SIGKILL");reject(new Error("payment_live_output_invalid"));}return;}
      let index;
      while((index=buffer.indexOf("\n"))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        try{const event=JSON.parse(line);if(event?.event==="final"&&event.result&&typeof event.result==="object")final=event.result;else if(onEvent&&typeof event?.event==="string")eventWrites=eventWrites.then(()=>Promise.resolve(onEvent(event))).catch(()=>{});}catch{}
      }
    });
    child.once("error",()=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error("payment_live_runner_unavailable"));}});
    child.once("close",async()=>{
      if(settled)return;settled=true;clearTimeout(timer);
      await eventWrites.catch(()=>{});
      if(!final)return reject(new Error("payment_live_result_missing"));
      resolve(final);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function parsed(text:string){
  if(typeof text!=="string"||Buffer.byteLength(text)>MAX)throw new Error("billing_output_invalid");
  const value=JSON.parse(text);
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("billing_output_invalid");
  return value;
}

const VERIFIED_FAILURE_REASONS=new Set([
  "bank_declined","bank_verification_failed","payment_cancelled","session_expired","payment_rejected_reason_unavailable"
]);
const LIVE_TRACE_STAGES=new Set([
  "provider_session_started","provider_session_authenticated","invoice_revalidated","checkout_prepared",
  "browser_context_ready","three_ds2_preflight","gateway_submission_started","gateway_submission_result",
  "bank_ui_opened","provider_callback_correlated","provider_readback","completion_classified","execution_error","http_exchange"
]);
const FORENSIC_SECRET_NAME=/(?:^|[_$.-])(pan|cvc|cvv|expir(?:y|ation)?|password|passwd|pwd|pin|otp|one.?time|creq|pareq|threedsmethoddata(?:packed)?|csrf|xsrf|nonce|signature|secret|auth(?:orization)?|cookie|session(?:id)?|sid|token)(?:$|[_$.-])/i;
const FORENSIC_PERSONAL_NAME=/^(?:text|cardholder|holder|email|phone|postalcode|streetaddress|login|username|user)$/i;
const FORENSIC_PAN=/\b(?:\d ?){13,19}\b/;
const FORENSIC_BEARER=/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i;
function forensicRedaction(value:any){
  return !!value&&typeof value==="object"&&!Array.isArray(value)&&value.redacted===true&&
    Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=2000000&&Object.keys(value).sort().join(",")==="bytes,redacted";
}
function forensicSensitiveName(value:any){
  return typeof value==="string"&&(FORENSIC_SECRET_NAME.test(value)||FORENSIC_PERSONAL_NAME.test(value)||["$PAN","$CVC","$EXPIRY","MM","YYYY"].includes(value));
}
function forensicNodeSafe(value:any,key=""):boolean{
  if(forensicSensitiveName(key))return forensicRedaction(value);
  if(value===null||typeof value==="boolean"||typeof value==="number")return true;
  if(typeof value==="string")return value.length<=FORENSIC_SNAPSHOT_MAX&&!FORENSIC_PAN.test(value)&&!FORENSIC_BEARER.test(value)&&!value.includes("\u0000");
  if(Array.isArray(value))return value.length<=512&&value.every(v=>forensicNodeSafe(v));
  if(!value||typeof value!=="object")return false;
  if(typeof value.name==="string"&&forensicSensitiveName(value.name)&&Object.prototype.hasOwnProperty.call(value,"value")&&!forensicRedaction(value.value))return false;
  return Object.entries(value).every(([k,v])=>forensicNodeSafe(v,k));
}
function forensicSnapshotSafe(value:any){
  if(typeof value!=="string"||Buffer.byteLength(value)>FORENSIC_SNAPSHOT_MAX||value.includes("\u0000"))return false;
  try{return forensicNodeSafe(JSON.parse(value));}catch{return false;}
}
function forensicHttp(value:any){
  if(!value||typeof value!=="object"||Array.isArray(value)||!["GET","POST"].includes(value.method)||
    typeof value.origin!=="string"||!/^https:\/\/[^\s/]+$/.test(value.origin)||
    typeof value.path!=="string"||!value.path.startsWith("/")||value.path.length>512||
    !Number.isSafeInteger(value.requestBytes)||value.requestBytes<0||value.requestBytes>2000000||
    !forensicSnapshotSafe(value.requestSnapshot)||typeof value.requestSha256!=="string"||!/^[a-f0-9]{64}$/.test(value.requestSha256)||
    typeof value.requestTruncated!=="boolean"||!Number.isSafeInteger(value.durationMs)||value.durationMs<0||value.durationMs>120000)return null;
  const out:any={method:value.method,origin:value.origin,path:value.path,requestBytes:value.requestBytes,
    requestSnapshot:value.requestSnapshot,requestSha256:value.requestSha256,requestTruncated:value.requestTruncated,durationMs:value.durationMs};
  if(value.responseStatus!==undefined){
    if(!Number.isSafeInteger(value.responseStatus)||value.responseStatus<0||value.responseStatus>599||
      typeof value.responseOrigin!=="string"||!/^https:\/\/[^\s/]+$/.test(value.responseOrigin)||
      typeof value.responsePath!=="string"||!value.responsePath.startsWith("/")||value.responsePath.length>512||
      !Number.isSafeInteger(value.responseBytes)||value.responseBytes<0||value.responseBytes>2000000||
      !forensicSnapshotSafe(value.responseSnapshot)||typeof value.responseSha256!=="string"||!/^[a-f0-9]{64}$/.test(value.responseSha256)||
      typeof value.responseTruncated!=="boolean")return null;
    Object.assign(out,{responseStatus:value.responseStatus,responseOrigin:value.responseOrigin,responsePath:value.responsePath,
      responseBytes:value.responseBytes,responseSnapshot:value.responseSnapshot,responseSha256:value.responseSha256,responseTruncated:value.responseTruncated});
  }
  if(value.errorCode!==undefined){
    if(typeof value.errorCode!=="string"||!/^[A-Za-z0-9_.-]{1,96}$/.test(value.errorCode))return null;
    out.errorCode=value.errorCode;
  }
  if(out.responseStatus===undefined&&out.errorCode===undefined)return null;
  return out;
}
function verifiedFailureReason(value:any){
  return typeof value==="string"&&VERIFIED_FAILURE_REASONS.has(value)?value:"payment_rejected_reason_unavailable";
}
async function forwardLiveTrace(context:PaymentTraceSink|undefined,event:any){
  if(!context?.trace||!event||typeof event!=="object"||!LIVE_TRACE_STAGES.has(event.event))return;
  const trace:any={stage:event.event};
  if(typeof event.outcome==="string"&&/^[a-z0-9_.-]{1,64}$/.test(event.outcome))trace.outcome=event.outcome;
  if(typeof event.reason_code==="string"&&/^[a-z0-9_.-]{1,96}$/.test(event.reason_code))trace.reasonCode=event.reason_code;
  if(typeof event.invoice_state==="string"&&["unpaid","settled","balance_changed","not_observed","unknown"].includes(event.invoice_state))
    trace.invoiceState=event.invoice_state;
  if(event.event==="http_exchange"){
    const http=forensicHttp(event.exchange);
    if(!http)return;
    trace.http=http;
  }
  await context.trace(trace);
}

export type ClicToPayProviderConfig={
  id:string;label:string;payee:string;billingProvider?:string;referencePattern:RegExp;
  executionValidated?:boolean;localOwnerValidated?:boolean;unavailableReason?:string;
  bankNavigationOrigins?:readonly string[];
  acceptanceGate?:{filename:string;value:string};receiptPrefix?:string;
};

export type ClicToPayLivePaymentAdapterOptions={billingRoot?:string;stateDir?:string;exec?:ExecFn;liveRun?:LiveRunFn};

export function createClicToPayLivePaymentAdapter(config:ClicToPayProviderConfig,options:ClicToPayLivePaymentAdapterOptions={}):PaymentAdapter{
  if(!config||!/^[a-z][a-z0-9_.-]{1,60}$/.test(config.id)||typeof config.label!=="string"||!config.label||typeof config.payee!=="string"||!config.payee||!(config.referencePattern instanceof RegExp))throw new Error("invalid_live_payment_adapter_config");
  const billingRoot=options.billingRoot??path.join(os.homedir(),".openclaw","workspace","ui-playbooks","billing","direct-runtime");
  const stateDir=options.stateDir??process.env.OPENCLAW_STATE_DIR??path.join(os.homedir(),".openclaw");
  const execute=options.exec??runExec;
  const live=options.liveRun??runLive;
  const gatePath=config.acceptanceGate?path.join(stateDir,"clawmobile-companion",config.acceptanceGate.filename):null;

  const consumeGate=()=>{
    if(!gatePath||!config.acceptanceGate)return true;
    const consumed=gatePath+".consumed-"+process.pid;
    try{
      fs.renameSync(gatePath,consumed);
      const valid=fs.readFileSync(consumed,"utf8").trim()===config.acceptanceGate.value;
      fs.unlinkSync(consumed);
      return valid;
    }catch{
      try{fs.unlinkSync(consumed);}catch{}
      return false;
    }
  };

  const billingCli=path.join(billingRoot,"billing-cli.mjs");
  const cardCli=path.join(billingRoot,"payment-card-cli.mjs");
  const liveCli=path.join(billingRoot,"payment-live-acceptance-cli.mjs");

  async function readQuote(reference:string):Promise<PaymentQuote>{
    config.referencePattern.lastIndex=0;
    if(!config.referencePattern.test(reference))throw new Error("invalid_provider_reference");
    const out=parsed((await execute(process.execPath,[billingCli,config.billingProvider??config.id,"--exhaustive","--details"],20000)).stdout);
    if(out.coverage_complete!==true||!Array.isArray(out.providers)||out.providers.length!==1)throw new Error("billing_read_unverified");
    const row=out.providers[0];
    if(row?.provider!==(config.billingProvider??config.id)||row.coverage_complete!==true||!Array.isArray(row.items))throw new Error("billing_read_unverified");
    const matches=row.items.filter((item:any)=>item?.provider_invoice_id===reference);
    if(matches.length!==1||!Number.isSafeInteger(matches[0].amount_pending_millimes)||matches[0].amount_pending_millimes<=0)
      throw new Error("selected_invoice_changed");
    return {payee:config.payee,reference,amountMinor:matches[0].amount_pending_millimes,currency:matches[0].currency??row.currency??"TND",decimals:3};
  }

  async function executeProvider(
    quote:PaymentQuote,
    requestId:string,
    context:PaymentExecutionContext|undefined,
    requireGate:boolean
  ):Promise<PaymentExecutionResult>{
    if(!context||typeof context.bankReturnToken!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(context.bankReturnToken))
      return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};

    if(requireGate&&!consumeGate())
      return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};

    const card=parsed((await execute(process.execPath,[cardCli,"status"],15000)).stdout);
    if(card.state!=="ready"||typeof card.last4!=="string"||!/^[0-9]{4}$/.test(card.last4)||card.cvc_stored!==true)
      return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};

    const result=await live(liveCli,{operation:"start",paymentRequestId:requestId,bankReturnToken:context.bankReturnToken,
      provider:config.id,request:{invoice_id:quote.reference,expected_amount_millimes:quote.amountMinor,currency:quote.currency,expected_last4:card.last4}},START_TIMEOUT_MS,
      event=>forwardLiveTrace(context,event));

    if(result?.state==="requires_bank_action"&&result.reason_code==="bank_verification_required"){
      const c=result.continuation as PaymentContinuation|undefined;
      if(!c||c.provider!==config.id||!/^[0-9]{1,32}$/.test(c.checkoutId)||!UUID.test(c.gatewayOrderId))
        return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
      return {state:"requires_bank_action",reasonCode:"bank_verification_required",continuation:c};
    }

    if(result?.state==="confirmed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true&&result.invoice_state==="settled"){
      if(!UUID.test(requestId))return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
      return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed",
        receipt:{reference:(config.receiptPrefix??("internal-"+config.id+"-"))+requestId,transactionCorrelated:true,providerReconciled:true}};
    }

    if(result?.state==="failed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true&&result.invoice_state==="unpaid")
      return {state:"failed",reasonCode:verifiedFailureReason(result.reason_code),rejectionVerified:true};

    return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
  }

  const adapter:PaymentAdapter={
    id:config.id,
    label:config.label,
    mode:"live",
    executionValidated:config.executionValidated===true,
    localOwnerValidated:config.localOwnerValidated===true,
    unavailableReason:config.unavailableReason??"provider_payment_contract_unverified",
    bankNavigationOrigins:config.bankNavigationOrigins,
    quote:readQuote,
    revalidate:async quote=>readQuote(quote.reference),
    execute:async (quote,requestId,context)=>executeProvider(quote,requestId,context,true),
    executeLocal:async (quote,requestId,context)=>executeProvider(quote,requestId,context,false),
    async resume(quote,requestId,continuation,traceSink):Promise<PaymentExecutionResult>{
      if(!continuation||continuation.provider!==config.id||!/^[0-9]{1,32}$/.test(continuation.checkoutId)||!UUID.test(continuation.gatewayOrderId))
        return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};

      const result=await live(liveCli,{operation:"resume",provider:config.id,request:{invoice_id:quote.reference,
        expected_amount_millimes:quote.amountMinor,currency:quote.currency},continuation},RESUME_TIMEOUT_MS,
        event=>forwardLiveTrace(traceSink,event));

      if(result?.state==="confirmed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true&&result.invoice_state==="settled"){
        if(!UUID.test(requestId))return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
        return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed",
          receipt:{reference:(config.receiptPrefix??("internal-"+config.id+"-"))+requestId,transactionCorrelated:true,providerReconciled:true}};
      }

      if(result?.state==="failed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true&&result.invoice_state==="unpaid")
        return {state:"failed",reasonCode:verifiedFailureReason(result.reason_code),rejectionVerified:true};

      return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    }
  };

  return adapter;
}
