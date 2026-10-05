const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path");
const {createClicToPayLivePaymentAdapter}=require("../dist/companion/clicToPayLivePaymentAdapter.js");

const requestId="11111111-1111-4111-8111-111111111111";
const bankReturnToken="B".repeat(43);
const continuation={provider:"utility_fixture",checkoutId:"42",gatewayOrderId:"22222222-2222-4222-8222-222222222222"};

test("generic ClicToPay provider factory carries provider identity end to end",async()=>{
 const tmp=path.join(os.homedir(),".cache","claw-tests");fs.mkdirSync(tmp,{recursive:true});
 const root=fs.mkdtempSync(path.join(tmp,"generic-payment-adapter-")),billing=path.join(root,"billing"),state=path.join(root,"state");
 fs.mkdirSync(path.join(state,"clawmobile-companion"),{recursive:true});
 const calls=[];
 const exec=async(_file,args)=>{
  calls.push(["exec",...args]);const script=String(args[0]);
  if(script.endsWith("billing-cli.mjs")){
   assert.equal(args[1],"utility_fixture");
   return {stderr:"",stdout:JSON.stringify({coverage_complete:true,providers:[{provider:"utility_fixture",coverage_complete:true,currency:"TND",items:[{provider_invoice_id:"U-42",amount_pending_millimes:12345,currency:"TND"}]}]})};
  }
  if(script.endsWith("payment-card-cli.mjs"))return {stderr:"",stdout:JSON.stringify({state:"ready",last4:"8503",cvc_stored:true})};
  throw Error("unexpected_exec");
 };
 const liveRun=async(_script,payload)=>{
  calls.push(["live",payload]);
  if(payload.operation==="start")return {state:"requires_bank_action",reason_code:"bank_verification_required",continuation};
  return {state:"confirmed",gateway_return_correlated:true,fresh_provider_read:true,invoice_state:"settled"};
 };
 const adapter=createClicToPayLivePaymentAdapter({id:"utility_fixture",label:"Utility",payee:"UTILITY",referencePattern:/^U-[0-9]+$/,localOwnerValidated:true},{billingRoot:billing,stateDir:state,exec,liveRun});
 try{
  const payables=await adapter.listPayables();
  assert.deepEqual(payables,[{payee:"UTILITY",reference:"U-42",amountMinor:12345,currency:"TND",decimals:3}]);
  const quote=await adapter.quote("U-42");
  assert.deepEqual(quote,{payee:"UTILITY",reference:"U-42",amountMinor:12345,currency:"TND",decimals:3});
  const started=await adapter.executeLocal(quote,requestId,{bankReturnToken});
  assert.equal(started.state,"requires_bank_action");assert.equal(started.continuation.provider,"utility_fixture");
  const startPayload=calls.find(x=>x[0]==="live")[1];
  assert.equal(startPayload.provider,"utility_fixture");assert.equal(startPayload.operation,"start");
  const done=await adapter.resume(quote,requestId,continuation);
  assert.equal(done.state,"confirmed");
  const resumePayload=calls.filter(x=>x[0]==="live").at(-1)[1];
  assert.equal(resumePayload.provider,"utility_fixture");assert.equal(resumePayload.operation,"resume");
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("provider continuation cannot cross adapters",async()=>{
 const adapter=createClicToPayLivePaymentAdapter({id:"utility_fixture",label:"Utility",payee:"UTILITY",referencePattern:/^U-[0-9]+$/,localOwnerValidated:true},{
  exec:async()=>{throw Error("unused")},liveRun:async()=>{throw Error("must_not_run")}
 });
 const out=await adapter.resume({payee:"UTILITY",reference:"U-42",amountMinor:1,currency:"TND",decimals:3},requestId,{...continuation,provider:"other"});
 assert.deepEqual(out,{state:"effect_unknown",reasonCode:"payment_effect_unverified"});
});
