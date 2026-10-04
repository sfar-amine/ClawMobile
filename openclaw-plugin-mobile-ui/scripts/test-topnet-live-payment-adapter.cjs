const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path");
const {createTopnetLivePaymentAdapter}=require("../dist/companion/topnetLivePaymentAdapter.js");

const invoice="20263531507";
const requestId="11111111-1111-4111-8111-111111111111";

function fixture({enabled=true,liveResult}={}){
 const tmp=path.join(os.homedir(),".cache","claw-tests");fs.mkdirSync(tmp,{recursive:true});
 const root=fs.mkdtempSync(path.join(tmp,"topnet-adapter-"));
 const state=path.join(root,"state"),billing=path.join(root,"billing");
 fs.mkdirSync(path.join(state,"clawmobile-companion"),{recursive:true});
 if(enabled)fs.writeFileSync(path.join(state,"clawmobile-companion","topnet-live-acceptance.enabled"),"topnet-v1-live-acceptance\n");
 const calls=[];
 const exec=async(_file,args)=>{
  calls.push(["exec",...args]);
  const script=String(args[0]);
  if(script.endsWith("billing-cli.mjs"))return {stderr:"",stdout:JSON.stringify({
   coverage_complete:true,providers:[{provider:"topnet",coverage_complete:true,items:[
    {provider_invoice_id:invoice,amount_pending_millimes:60900}
   ]}]
  })};
  if(script.endsWith("payment-card-cli.mjs"))return {stderr:"",stdout:JSON.stringify({state:"ready",last4:"8503",cvc_stored:true})};
  throw Error("unexpected_exec");
 };
 let liveCalls=0;
 const liveRun=async(_script,request)=>{
  liveCalls++;calls.push(["live",request]);
  return liveResult??{state:"confirmed",gateway_return_correlated:true,fresh_provider_read:true,invoice_state:"settled"};
 };
 const adapter=createTopnetLivePaymentAdapter({billingRoot:billing,stateDir:state,exec,liveRun});
 return {adapter,calls,liveCalls:()=>liveCalls,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test("gate keeps Topnet unavailable until acceptance flag exists",()=>{
 const f=fixture({enabled:false});
 assert.equal(f.adapter.executionValidated,false);
 assert.equal(f.adapter.unavailableReason,"provider_payment_contract_unverified");
 f.cleanup();
});

test("quote is exact and live execution dispatches once",async()=>{
 const f=fixture();
 try{
  assert.equal(f.adapter.executionValidated,true);
  const q=await f.adapter.quote(invoice);
  assert.deepEqual(q,{payee:"TOPNET",reference:invoice,amountMinor:60900,currency:"TND",decimals:3});
  const result=await f.adapter.execute(q,requestId);
  assert.equal(result.state,"confirmed");
  assert.equal(result.reasonCode,"gateway_and_provider_confirmed");
  assert.equal(result.receipt.transactionCorrelated,true);
  assert.equal(result.receipt.providerReconciled,true);
  assert.equal(f.liveCalls(),1);
  const live=f.calls.find(x=>x[0]==="live")[1];
  assert.deepEqual(live,{invoice_id:invoice,expected_amount_millimes:60900,currency:"TND",expected_last4:"8503"});
 }finally{f.cleanup();}
});

test("acceptance gate is consumed before the only live dispatch",async()=>{
 const f=fixture();
 try{
  const q=await f.adapter.quote(invoice);
  assert.equal((await f.adapter.execute(q,requestId)).state,"confirmed");
  assert.equal((await f.adapter.execute(q,"22222222-2222-4222-8222-222222222222")).state,"effect_unknown");
  assert.equal(f.liveCalls(),1);
 }finally{f.cleanup();}
});

test("unattributed settlement never confirms",async()=>{
 const f=fixture({liveResult:{state:"confirmed",gateway_return_correlated:false,fresh_provider_read:true,invoice_state:"settled"}});
 try{
  const q=await f.adapter.quote(invoice),result=await f.adapter.execute(q,requestId);
  assert.equal(result.state,"effect_unknown");
  assert.equal(result.reasonCode,"payment_effect_unverified");
  assert.equal(f.liveCalls(),1);
 }finally{f.cleanup();}
});

test("verified correlated rejection maps to failed without retry",async()=>{
 const f=fixture({liveResult:{state:"failed",gateway_return_correlated:true,fresh_provider_read:true,invoice_state:"unpaid"}});
 try{
  const q=await f.adapter.quote(invoice),result=await f.adapter.execute(q,requestId);
  assert.deepEqual(result,{state:"failed",reasonCode:"bank_declined",rejectionVerified:true});
  assert.equal(f.liveCalls(),1);
 }finally{f.cleanup();}
});
