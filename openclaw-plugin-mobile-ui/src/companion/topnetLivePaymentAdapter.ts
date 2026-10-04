import fs from "fs";
import os from "os";
import path from "path";
import {execFile, spawn} from "child_process";
import type {PaymentAdapter,PaymentContinuation,PaymentExecutionResult,PaymentQuote} from "./paymentTypes";

type ExecResult={stdout:string;stderr:string};
type ExecFn=(file:string,args:string[],timeoutMs:number)=>Promise<ExecResult>;
type LiveRunFn=(script:string,payload:Record<string,unknown>,timeoutMs:number)=>Promise<any>;

const MAX=65536;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const INVOICE=/^[A-Za-z0-9._-]{1,100}$/;

function runExec(file:string,args:string[],timeoutMs:number):Promise<ExecResult>{
 return new Promise((resolve,reject)=>{
  execFile(file,args,{timeout:timeoutMs,maxBuffer:MAX,encoding:"utf8"},(error,stdout,stderr)=>{
   if(error)return reject(new Error("billing_adapter_unavailable"));
   resolve({stdout,stderr});
  });
 });
}

function runLive(script:string,payload:Record<string,unknown>,timeoutMs:number):Promise<any>{
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[script],{stdio:["pipe","pipe","ignore"]});
  let buffer="",final:any=null,settled=false;
  const timer=setTimeout(()=>{if(!settled){settled=true;child.kill("SIGKILL");reject(new Error("payment_live_timeout"));}},timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data",(chunk:string)=>{
   buffer+=chunk;
   if(Buffer.byteLength(buffer)>MAX){if(!settled){settled=true;clearTimeout(timer);child.kill("SIGKILL");reject(new Error("payment_live_output_invalid"));}return;}
   let index;
   while((index=buffer.indexOf("\n"))>=0){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    try{const event=JSON.parse(line);if(event?.event==="final"&&event.result&&typeof event.result==="object")final=event.result;}catch{}
   }
  });
  child.once("error",()=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error("payment_live_runner_unavailable"));}});
  child.once("close",()=>{
   if(settled)return;settled=true;clearTimeout(timer);
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

export function createTopnetLivePaymentAdapter(options:{
 billingRoot?:string;stateDir?:string;exec?:ExecFn;liveRun?:LiveRunFn
}={}):PaymentAdapter{
 const billingRoot=options.billingRoot??path.join(os.homedir(),".openclaw","workspace","ui-playbooks","billing","direct-runtime");
 const stateDir=options.stateDir??process.env.OPENCLAW_STATE_DIR??path.join(os.homedir(),".openclaw");
 const execute=options.exec??runExec,live=options.liveRun??runLive;
 const gatePath=path.join(stateDir,"clawmobile-companion","topnet-live-acceptance.enabled");
 const enabled=()=>{
  try{return fs.readFileSync(gatePath,"utf8").trim()==="topnet-v1-live-acceptance";}
  catch{return false;}
 };
 const consumeGate=()=>{
  const consumed=gatePath+".consumed-"+process.pid;
  try{
   fs.renameSync(gatePath,consumed);
   const valid=fs.readFileSync(consumed,"utf8").trim()==="topnet-v1-live-acceptance";
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
  if(!INVOICE.test(reference))throw new Error("invalid_topnet_reference");
  const out=parsed((await execute(process.execPath,[billingCli,"topnet","--exhaustive","--details"],20000)).stdout);
  if(out.coverage_complete!==true||!Array.isArray(out.providers)||out.providers.length!==1)throw new Error("billing_read_unverified");
  const row=out.providers[0];
  if(row?.provider!=="topnet"||row.coverage_complete!==true||!Array.isArray(row.items))throw new Error("billing_read_unverified");
  const matches=row.items.filter((item:any)=>item?.provider_invoice_id===reference);
  if(matches.length!==1||!Number.isSafeInteger(matches[0].amount_pending_millimes)||matches[0].amount_pending_millimes<=0)
   throw new Error("selected_invoice_changed");
  return {payee:"TOPNET",reference,amountMinor:matches[0].amount_pending_millimes,currency:"TND",decimals:3};
 }

 const adapter:PaymentAdapter={
  id:"topnet",label:"TOPNET",mode:"live",executionValidated:enabled(),
  unavailableReason:enabled()?undefined:"provider_payment_contract_unverified",
  quote:readQuote,
  revalidate:async quote=>readQuote(quote.reference),
  async execute(quote,requestId,context):Promise<PaymentExecutionResult>{
   if(!context||typeof context.bankReturnToken!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(context.bankReturnToken))
    return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
   if(!consumeGate())return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
   const card=parsed((await execute(process.execPath,[cardCli,"status"],15000)).stdout);
   if(card.state!=="ready"||typeof card.last4!=="string"||!/^[0-9]{4}$/.test(card.last4)||card.cvc_stored!==true)
    return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
   const result=await live(liveCli,{operation:"start",paymentRequestId:requestId,bankReturnToken:context.bankReturnToken,
    request:{invoice_id:quote.reference,expected_amount_millimes:quote.amountMinor,currency:quote.currency,expected_last4:card.last4}},30000);
   if(result?.state==="requires_bank_action"&&result.reason_code==="bank_verification_required"){
    const c=result.continuation as PaymentContinuation|undefined;
    if(!c||c.provider!=="topnet"||!/^[0-9]{1,32}$/.test(c.checkoutId)||!UUID.test(c.gatewayOrderId))
     return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    return {state:"requires_bank_action",reasonCode:"bank_verification_required",continuation:c};
   }
   if(result?.state==="confirmed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true&&result.invoice_state==="settled"){
    if(!UUID.test(requestId))return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed",
     receipt:{reference:"internal-topnet-"+requestId,transactionCorrelated:true,providerReconciled:true}};
   }
   if(result?.state==="failed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true&&result.invoice_state==="unpaid")
    return {state:"failed",reasonCode:"bank_declined",rejectionVerified:true};
   return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
  },
  async resume(quote,requestId,continuation):Promise<PaymentExecutionResult>{
   if(!continuation||continuation.provider!=="topnet"||!/^[0-9]{1,32}$/.test(continuation.checkoutId)||!UUID.test(continuation.gatewayOrderId))
    return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
   const result=await live(liveCli,{operation:"resume",request:{invoice_id:quote.reference,
    expected_amount_millimes:quote.amountMinor,currency:quote.currency},continuation},30000);
   if(result?.state==="confirmed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true&&result.invoice_state==="settled"){
    if(!UUID.test(requestId))return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
    return {state:"confirmed",reasonCode:"gateway_and_provider_confirmed",
     receipt:{reference:"internal-topnet-"+requestId,transactionCorrelated:true,providerReconciled:true}};
   }
   if(result?.state==="failed"&&result.gateway_return_correlated===true&&result.fresh_provider_read===true&&result.invoice_state==="unpaid")
    return {state:"failed",reasonCode:"bank_declined",rejectionVerified:true};
   return {state:"effect_unknown",reasonCode:"payment_effect_unverified"};
  }
 };
 return adapter;
}
