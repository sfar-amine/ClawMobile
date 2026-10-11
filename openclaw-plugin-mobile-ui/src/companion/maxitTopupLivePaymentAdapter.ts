import fs from "fs";
import os from "os";
import path from "path";
import {execFile,spawn} from "child_process";
import type {
  PaymentAdapter,PaymentContinuation,PaymentExecutionContext,PaymentExecutionResult,
  PaymentQuote,PaymentTraceSink
} from "./paymentTypes";

type ExecJsonFn=(file:string,args:string[],timeoutMs:number)=>Promise<any>;
type LiveRunFn=(script:string,payload:Record<string,unknown>,timeoutMs:number,onEvent?:(event:any)=>Promise<void>|void)=>Promise<any>;
export type MaxitTopupLivePaymentAdapterOptions={uiRoot?:string;stateDir?:string;execJson?:ExecJsonFn;liveRun?:LiveRunFn};

const REF=/^topup-[a-f0-9]{32}-[a-f0-9]{32}-[1-9][0-9]{0,8}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TX=/^[0-9]{1,32}$/;
const GATE_FILE="maxit-topup-live-acceptance.enabled";
const GATE_VALUE="maxit-topup-v1-live-acceptance";
const MAX=65536,LIVE_MAX=524288;
// P1-5 nested budgets (11/10): each layer waits longer than what it calls.
//   quote : Python provider 40 s < this runner 43 s < Payment Core quote bound 45 s
//   start : this runner 220 s < Payment Core execution bound 230 s < Android local-start call
//   resume: Python status 40 s < this runner 60 s < Payment Core resume bound 65 s < Android bank-return call
/** Upstream contract: ui-playbooks billing/direct-runtime PROVIDER_TIMEOUT_MS (Python provider, guarded). */
export const MAXIT_PROVIDER_BUDGET_MS=40000;
export const MAXIT_QUOTE_RUN_TIMEOUT_MS=43000;
export const MAXIT_START_RUN_TIMEOUT_MS=220000;
export const MAXIT_RESUME_RUN_TIMEOUT_MS=60000;
const REASON_CODE=/^[a-z0-9_]{1,96}$/;
const reasonDetailOf=(value:any)=>typeof value==="string"&&REASON_CODE.test(value)?value:undefined;

function defaultExecJson(file:string,args:string[],timeoutMs:number):Promise<any>{
  return new Promise((resolve,reject)=>execFile(file,args,{timeout:timeoutMs,maxBuffer:MAX,encoding:"utf8"},(error,stdout)=>{
    if(error)return reject(new Error("maxit_card_status_unavailable"));
    try{
      const value=JSON.parse(stdout);
      if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();
      resolve(value);
    }catch{return reject(new Error("maxit_card_status_unavailable"));}
  }));
}

function defaultLiveRun(script:string,payload:Record<string,unknown>,timeoutMs:number,onEvent?:(event:any)=>Promise<void>|void):Promise<any>{
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script],{stdio:["pipe","pipe","ignore"]});
    let buffer="",final:any=null,settled=false,writes=Promise.resolve();
    const timer=setTimeout(()=>{if(!settled){settled=true;child.kill("SIGKILL");reject(new Error("maxit_topup_runner_timeout"));}},timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",(chunk:string)=>{
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>LIVE_MAX){
        if(!settled){settled=true;clearTimeout(timer);child.kill("SIGKILL");reject(new Error("maxit_topup_runner_output_invalid"));}
        return;
      }
      let i;
      while((i=buffer.indexOf("\n"))>=0){
        const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        try{
          const event=JSON.parse(line);
          if(event?.event==="final"&&event.result&&typeof event.result==="object")final=event.result;
          else if(onEvent&&typeof event?.event==="string")
            writes=writes.then(()=>Promise.resolve(onEvent(event))).catch(()=>{});
        }catch{}
      }
    });
    child.once("error",()=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error("maxit_topup_runner_unavailable"));}});
    child.once("close",async()=>{
      if(settled)return;
      settled=true;clearTimeout(timer);await writes.catch(()=>{});
      if(!final)return reject(new Error("maxit_topup_result_missing"));
      resolve(final);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function forwardTrace(sink:PaymentTraceSink|undefined,event:any){
  if(!sink?.trace||!event||typeof event!=="object")return;
  if(event.event==="http_exchange"&&event.exchange){
    await sink.trace({stage:"http_exchange",http:event.exchange});return;
  }
  if(event.event==="three_ds2_preflight_completed"){
    await sink.trace({stage:"three_ds2_preflight",outcome:typeof event.outcome==="string"?event.outcome:undefined});return;
  }
  const allowed=new Set([
    "provider_session_started","checkout_prepared","browser_context_ready",
    "gateway_submission_started","gateway_submission_result","bank_ui_opened",
    "provider_readback","execution_error"
  ]);
  if(allowed.has(event.event))await sink.trace({
    stage:event.event,
    outcome:typeof event.outcome==="string"?event.outcome:undefined,
    reasonCode:typeof event.reason_code==="string"?event.reason_code:undefined,
    reasonDetail:reasonDetailOf(event.reason_detail),
    invoiceState:typeof event.invoice_state==="string"?event.invoice_state:undefined
  });
}

function validContinuation(value:any):value is PaymentContinuation{
  return !!value&&typeof value==="object"&&!Array.isArray(value)&&
    // Webview contract (11/10): Maxit no longer returns its transaction id, the continuation keeps it empty.
    value.provider==="maxit.topup"&&typeof value.checkoutId==="string"&&(value.checkoutId===""||TX.test(value.checkoutId))&&
    typeof value.gatewayOrderId==="string"&&UUID.test(value.gatewayOrderId);
}

function notSubmitted(reasonDetail?:string):PaymentExecutionResult{
  return {state:"blocked",reasonCode:"payment_not_submitted",...(reasonDetail?{reasonDetail}:{})};
}

function mapResult(result:any,requestId:string):PaymentExecutionResult{
  // P1-3: the live runner proves no gateway submission happened (card never sent): honest block,
  // not an uncertain effect. Anything else without that proof stays effect_unknown.
  if(result?.state==="not_submitted"&&result.submission_attempted===false)
    return notSubmitted(reasonDetailOf(result.reason_detail)??reasonDetailOf(result.reason_code));
  if(result?.state==="requires_bank_action"&&result.reason_code==="bank_verification_required"&&validContinuation(result.continuation))
    return {state:"requires_bank_action",reasonCode:"bank_verification_required",continuation:result.continuation};
  if(result?.state==="confirmed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true){
    if(!UUID.test(requestId))return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed",
      receipt:{reference:"internal-maxit-topup-"+requestId,transactionCorrelated:true,providerReconciled:true}};
  }
  if(result?.state==="failed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true)
    return {state:"failed",reasonCode:"payment_rejected_reason_unavailable",rejectionVerified:true};
  const detail=reasonDetailOf(result?.reason_detail);
  return {state:"effect_unknown",reasonCode:"payment_effect_unverified",...(detail?{reasonDetail:detail}:{})};
}

export function createMaxitTopupLivePaymentAdapter(options:MaxitTopupLivePaymentAdapterOptions={}):PaymentAdapter{
  const uiRoot=options.uiRoot??path.join(os.homedir(),".openclaw","workspace","ui-playbooks");
  const stateDir=options.stateDir??process.env.OPENCLAW_STATE_DIR??path.join(os.homedir(),".openclaw");
  const liveCli=path.join(uiRoot,"billing","direct-runtime","maxit-topup-live-cli.mjs");
  const cardCli=path.join(uiRoot,"billing","direct-runtime","payment-card-cli.mjs");
  const gatePath=path.join(stateDir,"clawmobile-companion",GATE_FILE);
  const execJson=options.execJson??defaultExecJson;
  const liveRun=options.liveRun??defaultLiveRun;
  const gateReady=()=>{try{return fs.readFileSync(gatePath,"utf8").trim()===GATE_VALUE;}catch{return false;}};
  const armed=gateReady();

  async function quote(reference:string):Promise<PaymentQuote>{
    if(!REF.test(reference))throw new Error("invalid_maxit_topup_reference");
    const result=await liveRun(liveCli,{operation:"quote",reference},MAXIT_QUOTE_RUN_TIMEOUT_MS);
    // A quote has no effect: its precise block reason reaches the owner (P0-8), never a raw dump.
    if(result?.state==="blocked")throw new Error(reasonDetailOf(result.reason_code)??"maxit_quote_contract_unverified");
    const q=result?.quote;
    if(result?.state!=="quote_ready"||!q||typeof q.payee!=="string"||!/^Orange Maxit ••••[0-9]{4}$/.test(q.payee)||
       q.reference!==reference||q.currency!=="TND"||q.decimals!==3||!Number.isSafeInteger(q.amountMinor)||q.amountMinor<=0)
      throw new Error("maxit_quote_contract_unverified");
    return q;
  }

  async function executeLocal(quoteValue:PaymentQuote,requestId:string,context?:PaymentExecutionContext):Promise<PaymentExecutionResult>{
    // Gate or card absent: nothing has been sent anywhere, so the record is blocked (P1-3).
    if(!armed||!gateReady())return notSubmitted("maxit_live_acceptance_not_armed");
    if(!context||typeof context.bankReturnToken!=="string")return notSubmitted("payment_context_unavailable");
    let card:any;
    try{card=await execJson(process.execPath,[cardCli,"status"],15000);}catch{return notSubmitted("payment_card_status_unavailable");}
    if(card?.state!=="ready"||typeof card.last4!=="string"||!/^[0-9]{4}$/.test(card.last4)||card.cvc_stored!==true)
      return notSubmitted("payment_card_not_ready");
    try{
      const result=await liveRun(liveCli,{
        operation:"start",
        request:{reference:quoteValue.reference,expected_amount_millimes:quoteValue.amountMinor,expected_last4:card.last4},
        context:{paymentRequestId:requestId,bankReturnToken:context.bankReturnToken}
      },MAXIT_START_RUN_TIMEOUT_MS,event=>forwardTrace(context,event));
      return mapResult(result,requestId);
    }catch{
      return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    }
  }

  async function observe(operation:"resume"|"status",quoteValue:PaymentQuote,requestId:string,continuation?:PaymentContinuation,traceSink?:PaymentTraceSink){
    if(!validContinuation(continuation))return {state:"effect_unknown",reasonCode:"payment_effect_unverified"} as PaymentExecutionResult;
    try{
      const result=await liveRun(liveCli,{
        operation,
        request:{reference:quoteValue.reference,expected_amount_millimes:quoteValue.amountMinor},
        continuation
      },MAXIT_RESUME_RUN_TIMEOUT_MS,event=>forwardTrace(traceSink,event));
      return mapResult(result,requestId);
    }catch{
      return {state:"effect_unknown",reasonCode:"payment_effect_unverified"} as PaymentExecutionResult;
    }
  }

  return {
    id:"maxit.topup",
    label:"Orange Maxit — recharge de mon numéro",
    mode:"live",
    executionValidated:false,
    localOwnerValidated:armed,
    unavailableReason:armed?"maxit_live_acceptance_pending":"maxit_live_acceptance_not_armed",
    bankNavigationOrigins:[
      "https://3ds2.clictopay.com",
      "https://ipay.clictopay.com",
      "https://krakend-bff.maxit.orange.tn"
    ],
    quote,
    revalidate:async q=>quote(q.reference),
    executeLocal,
    resume:async(q,id,c,sink)=>observe("resume",q,id,c,sink),
    timeoutReconcile:async(q,id,c,sink)=>observe("status",q,id,c,sink)
  };
}
