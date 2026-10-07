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
const MAX=65536,LIVE_MAX=524288,START_TIMEOUT_MS=225000,RESUME_TIMEOUT_MS=60000;

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
    invoiceState:typeof event.invoice_state==="string"?event.invoice_state:undefined
  });
}

function validContinuation(value:any):value is PaymentContinuation{
  return !!value&&typeof value==="object"&&!Array.isArray(value)&&
    value.provider==="maxit.topup"&&typeof value.checkoutId==="string"&&TX.test(value.checkoutId)&&
    typeof value.gatewayOrderId==="string"&&UUID.test(value.gatewayOrderId);
}

function mapResult(result:any,requestId:string):PaymentExecutionResult{
  if(result?.state==="requires_bank_action"&&result.reason_code==="bank_verification_required"&&validContinuation(result.continuation))
    return {state:"requires_bank_action",reasonCode:"bank_verification_required",continuation:result.continuation};
  if(result?.state==="confirmed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true){
    if(!UUID.test(requestId))return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed",
      receipt:{reference:"internal-maxit-topup-"+requestId,transactionCorrelated:true,providerReconciled:true}};
  }
  if(result?.state==="failed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true)
    return {state:"failed",reasonCode:"payment_rejected_reason_unavailable",rejectionVerified:true};
  return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
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
    const result=await liveRun(liveCli,{operation:"quote",reference},60000);
    const q=result?.quote;
    if(result?.state!=="quote_ready"||!q||typeof q.payee!=="string"||!/^Orange Maxit ••••[0-9]{4}$/.test(q.payee)||
       q.reference!==reference||q.currency!=="TND"||q.decimals!==3||!Number.isSafeInteger(q.amountMinor)||q.amountMinor<=0)
      throw new Error("maxit_quote_contract_unverified");
    return q;
  }

  async function executeLocal(quoteValue:PaymentQuote,requestId:string,context?:PaymentExecutionContext):Promise<PaymentExecutionResult>{
    if(!armed||!gateReady()||!context||typeof context.bankReturnToken!=="string")
      return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    let card:any;
    try{card=await execJson(process.execPath,[cardCli,"status"],15000);}catch{return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};}
    if(card?.state!=="ready"||typeof card.last4!=="string"||!/^[0-9]{4}$/.test(card.last4)||card.cvc_stored!==true)
      return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    try{
      const result=await liveRun(liveCli,{
        operation:"start",
        request:{reference:quoteValue.reference,expected_amount_millimes:quoteValue.amountMinor,expected_last4:card.last4},
        context:{paymentRequestId:requestId,bankReturnToken:context.bankReturnToken}
      },START_TIMEOUT_MS,event=>forwardTrace(context,event));
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
      },RESUME_TIMEOUT_MS,event=>forwardTrace(traceSink,event));
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
