const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path");
const {createMaxitTopupLivePaymentAdapter}=require("../dist/companion/maxitTopupLivePaymentAdapter.js");

const requestId="11111111-1111-4111-8111-111111111111";
const bankReturnToken="B".repeat(43);
const reference="topup-"+"a".repeat(32)+"-"+"b".repeat(32)+"-5000";
const quote={payee:"Orange Maxit ••••1234",reference,amountMinor:5000,currency:"TND",decimals:3};
const continuation={provider:"maxit.topup",checkoutId:"456789",gatewayOrderId:"22222222-2222-4222-8222-222222222222"};

function fixture({armed=true}={}){
  const tmp=path.join(os.homedir(),".cache","claw-tests");fs.mkdirSync(tmp,{recursive:true});
  const root=fs.mkdtempSync(path.join(tmp,"maxit-topup-adapter-"));
  const state=path.join(root,"state"),ui=path.join(root,"ui");
  fs.mkdirSync(path.join(state,"clawmobile-companion"),{recursive:true});
  if(armed)fs.writeFileSync(path.join(state,"clawmobile-companion","maxit-topup-live-acceptance.enabled"),"maxit-topup-v1-live-acceptance\n");
  const calls=[];
  const execJson=async(_file,args)=>{calls.push(["card",...args]);return {state:"ready",last4:"8503",cvc_stored:true};};
  const liveRun=async(_script,payload,_timeout,onEvent)=>{
    calls.push(["live",payload]);
    if(payload.operation==="quote")return {state:"quote_ready",quote};
    if(payload.operation==="start"){
      assert.deepEqual(Object.keys(payload.request).sort(),["expected_amount_millimes","expected_last4","reference"]);
      assert.equal(payload.request.reference,reference);
      assert.equal(payload.request.expected_amount_millimes,5000);
      assert.equal(payload.request.expected_last4,"8503");
      assert.equal("invoice_id" in payload.request,false);
      assert.equal("currency" in payload.request,false);
      assert.deepEqual(Object.keys(payload.context).sort(),["bankReturnToken","paymentRequestId"]);
      await onEvent?.({event:"provider_session_started"});
      return {state:"requires_bank_action",reason_code:"bank_verification_required",continuation};
    }
    if(payload.operation==="resume"||payload.operation==="status"){
      assert.deepEqual(payload.request,{reference,expected_amount_millimes:5000});
      assert.deepEqual(payload.continuation,continuation);
      await onEvent?.({event:"provider_readback",invoice_state:"settled"});
      return {state:"confirmed",reason_code:"gateway_return_and_provider_settled",
        gateway_return_correlated:true,fresh_provider_read:true};
    }
    throw Error("unexpected_operation");
  };
  const adapter=createMaxitTopupLivePaymentAdapter({stateDir:state,uiRoot:ui,execJson,liveRun});
  return {root,adapter,calls};
}

test("Maxit topup stays disabled without explicit live acceptance gate",async()=>{
  const f=fixture({armed:false});
  try{
    assert.equal(f.adapter.localOwnerValidated,false);
    const out=await f.adapter.executeLocal(quote,requestId,{bankReturnToken});
    assert.deepEqual(out,{state:"effect_unknown",reasonCode:"payment_effect_unverified"});
    assert.equal(f.calls.length,0);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("Maxit start uses Maxit-specific request, never Topnet invoice fields",async()=>{
  const f=fixture();
  try{
    assert.equal(f.adapter.localOwnerValidated,true);
    const q=await f.adapter.quote(reference);assert.deepEqual(q,quote);
    const trace=[];
    const started=await f.adapter.executeLocal(q,requestId,{bankReturnToken,trace:e=>trace.push(e)});
    assert.equal(started.state,"requires_bank_action");
    assert.deepEqual(started.continuation,continuation);
    assert.ok(trace.some(x=>x.stage==="provider_session_started"));
    const start=f.calls.filter(x=>x[0]==="live").find(x=>x[1].operation==="start")[1];
    assert.equal(JSON.stringify(start).includes("invoice_id"),false);
    assert.equal(JSON.stringify(start).includes("topnet"),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("Maxit bank return and timeout reconcile only observe same transaction",async()=>{
  const f=fixture();
  try{
    const resumed=await f.adapter.resume(quote,requestId,continuation);
    assert.equal(resumed.state,"confirmed");
    assert.equal(resumed.receipt.providerReconciled,true);
    const reconciled=await f.adapter.timeoutReconcile(quote,requestId,continuation);
    assert.equal(reconciled.state,"confirmed");
    const ops=f.calls.filter(x=>x[0]==="live").map(x=>x[1].operation);
    assert.deepEqual(ops,["resume","status"]);
    assert.equal(f.calls.some(x=>JSON.stringify(x).includes("invoice_id")),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
