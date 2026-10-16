const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path");
const {createMaxitTopupLivePaymentAdapter,MAXIT_QUOTE_RUN_TIMEOUT_MS,MAXIT_START_RUN_TIMEOUT_MS,MAXIT_RESUME_RUN_TIMEOUT_MS}=require("../dist/companion/maxitTopupLivePaymentAdapter.js");

const requestId="11111111-1111-4111-8111-111111111111";
const bankReturnToken="B".repeat(43);
const reference="topup-"+"a".repeat(32)+"-"+"b".repeat(32)+"-5000";
const quote={payee:"Orange Maxit ••••1234",reference,amountMinor:5000,currency:"TND",decimals:3,feeMinor:700,totalMinor:5700,feeLabel:"Frais Maxit"};
const continuation={provider:"maxit.topup",checkoutId:"456789",gatewayOrderId:"22222222-2222-4222-8222-222222222222"};

function fixture({armed=true,live,card}={}){
  const tmp=path.join(os.homedir(),".cache","claw-tests");fs.mkdirSync(tmp,{recursive:true});
  const root=fs.mkdtempSync(path.join(tmp,"maxit-topup-adapter-"));
  const state=path.join(root,"state"),ui=path.join(root,"ui");
  fs.mkdirSync(path.join(state,"clawmobile-companion"),{recursive:true});
  if(armed)fs.writeFileSync(path.join(state,"clawmobile-companion","maxit-topup-live-acceptance.enabled"),"maxit-topup-v1-live-acceptance\n");
  const calls=[];
  const execJson=async(_file,args)=>{calls.push(["card",...args]);return card??{state:"ready",last4:"8503",cvc_stored:true};};
  const liveRun=async(_script,payload,timeout,onEvent)=>{
    calls.push(["live",payload,timeout]);
    if(live)return live(payload,onEvent);
    if(payload.operation==="quote")return {state:"quote_ready",quote};
    if(payload.operation==="start"){
      assert.deepEqual(Object.keys(payload.request).sort(),["expected_amount_millimes","expected_last4","expected_total_millimes","reference"]);
      assert.equal(payload.request.reference,reference);
      assert.equal(payload.request.expected_amount_millimes,5000);
      assert.equal(payload.request.expected_total_millimes,5700);
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
    // P1-3: nothing was sent anywhere, so the honest state is blocked (not effect_unknown).
    assert.deepEqual(out,{state:"blocked",reasonCode:"payment_not_submitted",reasonDetail:"maxit_live_acceptance_not_armed"});
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

// --- Lot paiement Maxit 11/10 (P1-3, P0-4, P0-8, P1-5) -----------------------------------------
test("P1-3 not_submitted without submission becomes blocked payment_not_submitted with its precise code",async()=>{
  const f=fixture({live:async(payload,onEvent)=>{
    await onEvent?.({event:"execution_error",reason_code:"maxit_order_creation_failed",reason_detail:"maxit_order_creation_failed"});
    return {state:"not_submitted",reason_code:"maxit_order_creation_failed",reason_detail:"maxit_order_creation_failed",submission_attempted:false};
  }});
  try{
    const trace=[];
    const out=await f.adapter.executeLocal(quote,requestId,{bankReturnToken,trace:e=>trace.push(e)});
    assert.deepEqual(out,{state:"blocked",reasonCode:"payment_not_submitted",reasonDetail:"maxit_order_creation_failed"});
    const error=trace.find(e=>e.stage==="execution_error");
    assert.equal(error.reasonCode,"maxit_order_creation_failed");
    assert.equal(error.reasonDetail,"maxit_order_creation_failed");
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("P1-3 a submitted attempt is never downgraded to blocked",async()=>{
  for(const result of [
    {state:"not_submitted",reason_code:"x",submission_attempted:true},
    {state:"effect_unknown",reason_code:"bank_ui_unavailable",reason_detail:"bank_ui_unavailable",submission_attempted:true}]){
    const f=fixture({live:async()=>result});
    try{
      const out=await f.adapter.executeLocal(quote,requestId,{bankReturnToken});
      assert.equal(out.state,"effect_unknown");
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
});

test("P1-3 card absent is blocked before any live run",async()=>{
  const f=fixture({card:{state:"missing"}});
  try{
    const out=await f.adapter.executeLocal(quote,requestId,{bankReturnToken});
    assert.deepEqual(out,{state:"blocked",reasonCode:"payment_not_submitted",reasonDetail:"payment_card_not_ready"});
    assert.equal(f.calls.some(x=>x[0]==="live"),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("P0-8 blocked quote surfaces the precise reason (never a contract error)",async()=>{
  const f=fixture({live:async()=>({state:"blocked",reason_code:"maxit_mobile_not_ready"})});
  try{
    await assert.rejects(f.adapter.quote(reference),e=>e.message==="maxit_mobile_not_ready");
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("P1-5 adapter runs use the nested named budgets",async()=>{
  const f=fixture();
  try{
    await f.adapter.quote(reference);
    await f.adapter.executeLocal(quote,requestId,{bankReturnToken});
    await f.adapter.resume(quote,requestId,continuation);
    const byOp=Object.fromEntries(f.calls.filter(x=>x[0]==="live").map(x=>[x[1].operation,x[2]]));
    assert.deepEqual(byOp,{quote:MAXIT_QUOTE_RUN_TIMEOUT_MS,start:MAXIT_START_RUN_TIMEOUT_MS,resume:MAXIT_RESUME_RUN_TIMEOUT_MS});
    assert.deepEqual([MAXIT_QUOTE_RUN_TIMEOUT_MS,MAXIT_START_RUN_TIMEOUT_MS,MAXIT_RESUME_RUN_TIMEOUT_MS],[43000,220000,60000]);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("Webview contract 11/10: an empty Maxit transaction id keeps the bank continuation, a malformed one does not",async()=>{
  const web={provider:"maxit.topup",checkoutId:"",gatewayOrderId:"22222222-2222-4222-8222-222222222222"};
  const make=checkoutId=>fixture({live:async payload=>payload.operation==="start"
    ?{state:"requires_bank_action",reason_code:"bank_verification_required",continuation:{...web,checkoutId}}
    :{state:"confirmed",reason_code:"gateway_return_and_provider_settled",gateway_return_correlated:true,fresh_provider_read:true}});
  const ok=make("");
  try{
    const started=await ok.adapter.executeLocal(quote,requestId,{bankReturnToken});
    assert.equal(started.state,"requires_bank_action");
    assert.deepEqual(started.continuation,web);
  }finally{fs.rmSync(ok.root,{recursive:true,force:true});}
  const bad=make("abc");
  try{
    const started=await bad.adapter.executeLocal(quote,requestId,{bankReturnToken});
    assert.equal(started.state,"effect_unknown");
  }finally{fs.rmSync(bad.root,{recursive:true,force:true});}
});

// --- Frais Maxit 11/10 : total débité confirmé = montant + frais ---------------------------------------------
test("Fee: a Maxit quote without an exact fee breakdown is refused",async()=>{
  const {feeMinor,totalMinor,feeLabel,...legacy}=quote;
  for(const q of [legacy,{...quote,totalMinor:5000},{...quote,feeMinor:-700,totalMinor:4300},{...quote,feeLabel:"Frais"}]){
    const f=fixture({live:async()=>({state:"quote_ready",quote:q})});
    try{await assert.rejects(f.adapter.quote(reference),e=>e.message==="maxit_quote_contract_unverified");}
    finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
});
test("Fee: a confirmed quote without total never reaches the runner",async()=>{
  const {feeMinor,totalMinor,feeLabel,...legacy}=quote;
  const f=fixture();
  try{
    const out=await f.adapter.executeLocal(legacy,requestId,{bankReturnToken});
    assert.deepEqual(out,{state:"blocked",reasonCode:"payment_not_submitted",reasonDetail:"maxit_quote_contract_unverified"});
    assert.equal(f.calls.some(x=>x[0]==="live"),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("Fee: owner confirmation shows amount, Maxit fee and total debited, and binds the total",async()=>{
  const {buildLocalPaymentIntent,localPaymentPayloadHash}=require("../dist/companion/localPaymentIntent.js");
  const {validateQuote,quoteDigest}=require("../dist/companion/paymentCore.js");
  const {localHandoffNotificationArgs,bankAuthorizationIntent}=require("../dist/companion/payments.js");
  const origin={channel:"samantha",id:"fixture"};
  const intent=buildLocalPaymentIntent({adapterId:"maxit.topup",quote,origin});
  assert.equal(intent.presentation.subtitle,"Total débité 5,700 TND à Orange Maxit ••••1234");
  assert.ok(intent.presentation.description.startsWith("Montant 5,000 TND · Frais Maxit 0,700 TND · Total débité 5,700 TND. Référence "+reference));
  assert.ok(intent.presentation.description.length<=320);
  const other={...quote,feeMinor:1000,totalMinor:6000};
  assert.notEqual(localPaymentPayloadHash("maxit.topup",quote),localPaymentPayloadHash("maxit.topup",other));
  assert.notEqual(quoteDigest("maxit.topup","live",quote),quoteDigest("maxit.topup","live",other));
  // Quotes without fee keep their v1 digest (other adapters, stored records).
  const {feeMinor,totalMinor,feeLabel,...plain}=quote;
  assert.equal(buildLocalPaymentIntent({adapterId:"x.y",quote:plain,origin}).presentation.subtitle,"5,000 TND à Orange Maxit ••••1234");
  assert.deepEqual(validateQuote(quote),quote);
  for(const bad of [{...quote,totalMinor:5701},{...quote,feeMinor:"700"},{...plain,totalMinor:5700},{...quote,feeLabel:""}])
    assert.throws(()=>validateQuote(bad));
  assert.match(localHandoffNotificationArgs(requestId,quote).at(-1),/5,700 TND$/);
  const bank=bankAuthorizationIntent({state:"requires_bank_action",requestId,adapterId:"maxit.topup",mode:"live",quote,origin});
  assert.equal(bank.presentation.subtitle,"Orange Maxit ••••1234 — 5.700 TND");
});
test("Fee: confirmed total equals the real ClicToPay sessions captured on the S24 (11/10)",async()=>{
  const capture=JSON.parse(fs.readFileSync(path.join(__dirname,"..","fixtures","s24-2026-10-11e","maxit-fee-gateway.json"),"utf8"));
  const {buildLocalPaymentIntent}=require("../dist/companion/localPaymentIntent.js");
  assert.equal(capture.clicToPaySessions.length,2);
  for(const s of capture.clicToPaySessions){
    const sessionMinor=Math.round(Number(s.totalAmountFormatted)*1000);
    // Fee rule owned by the provider (14 %): the quote it declares must equal what the gateway will ask.
    const feeMinor=s.amountMinor*1400/10000;
    const q={...quote,reference:"topup-"+"a".repeat(32)+"-"+"b".repeat(32)+"-"+s.amountMinor,amountMinor:s.amountMinor,feeMinor,totalMinor:s.amountMinor+feeMinor};
    assert.equal(q.totalMinor,sessionMinor);
    const f=fixture({live:async()=>({state:"quote_ready",quote:q})});
    try{assert.deepEqual(await f.adapter.quote(q.reference),q);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
    const shown=buildLocalPaymentIntent({adapterId:"maxit.topup",quote:q,origin:{channel:"samantha",id:"fixture"}}).presentation.subtitle;
    assert.ok(shown.includes(s.totalAmountFormatted.replace(".",",")+" TND"),shown);
  }
});
