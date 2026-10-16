// P1-5 (lot paiement Maxit 11/10): every layer waits longer than the layer it calls.
// Simulated clock only: no provider, no network, no payment.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("crypto"),fs=require("fs"),os=require("os"),path=require("path");
const {createPaymentCore,ownerKey,BANK_ACTION_TIMEOUT_MS}=require("../dist/companion/paymentCore.js");
const {PAYMENT_QUOTE_TIMEOUT_MS,PAYMENT_EXECUTION_TIMEOUT_MS,PAYMENT_RESUME_TIMEOUT_MS,LOCAL_START_ROUTE_BUDGET_MS}=require("../dist/companion/payments.js");
const adapterModule=require("../dist/companion/maxitTopupLivePaymentAdapter.js");
const {createMaxitTopupLivePaymentAdapter,MAXIT_PROVIDER_BUDGET_MS,MAXIT_QUOTE_RUN_TIMEOUT_MS,MAXIT_START_RUN_TIMEOUT_MS,MAXIT_RESUME_RUN_TIMEOUT_MS}=adapterModule;

const reference="topup-"+"a".repeat(32)+"-"+"b".repeat(32)+"-5000";
const quote={payee:"Orange Maxit ••••1234",reference,amountMinor:5000,currency:"TND",decimals:3,feeMinor:700,totalMinor:5700,feeLabel:"Frais Maxit"};

test("budgets are nested from the Python provider up to the route",()=>{
  assert.equal(MAXIT_PROVIDER_BUDGET_MS,40000);
  assert.ok(MAXIT_PROVIDER_BUDGET_MS<MAXIT_QUOTE_RUN_TIMEOUT_MS&&MAXIT_QUOTE_RUN_TIMEOUT_MS<PAYMENT_QUOTE_TIMEOUT_MS);
  assert.equal(PAYMENT_QUOTE_TIMEOUT_MS,45000);
  assert.ok(MAXIT_START_RUN_TIMEOUT_MS<PAYMENT_EXECUTION_TIMEOUT_MS);
  assert.deepEqual([MAXIT_START_RUN_TIMEOUT_MS,PAYMENT_EXECUTION_TIMEOUT_MS],[220000,230000]);
  assert.ok(MAXIT_PROVIDER_BUDGET_MS<MAXIT_RESUME_RUN_TIMEOUT_MS&&MAXIT_RESUME_RUN_TIMEOUT_MS<PAYMENT_RESUME_TIMEOUT_MS);
  assert.ok(PAYMENT_RESUME_TIMEOUT_MS<=PAYMENT_EXECUTION_TIMEOUT_MS);
  assert.equal(LOCAL_START_ROUTE_BUDGET_MS,PAYMENT_QUOTE_TIMEOUT_MS+PAYMENT_EXECUTION_TIMEOUT_MS);
  assert.equal(BANK_ACTION_TIMEOUT_MS,60000);
});

function core(liveDelayMs){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"pay-budget-"));
  fs.mkdirSync(path.join(tmp,"clawmobile-companion"),{recursive:true});
  fs.writeFileSync(path.join(tmp,"clawmobile-companion","maxit-topup-live-acceptance.enabled"),"maxit-topup-v1-live-acceptance\n");
  const runs=[];
  // The live runner stands for the guarded Python provider slowed to liveDelayMs.
  const liveRun=(_script,payload,timeoutMs)=>new Promise((resolve,reject)=>{
    runs.push(timeoutMs);
    const slow=setTimeout(()=>resolve({state:"quote_ready",quote}),liveDelayMs);
    setTimeout(()=>{clearTimeout(slow);reject(new Error("maxit_topup_runner_timeout"));},timeoutMs);
  });
  const adapter=createMaxitTopupLivePaymentAdapter({stateDir:tmp,uiRoot:tmp,liveRun,execJson:async()=>({})});
  const pair=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  let rows=[];
  const store={async read(){return structuredClone(rows)},async change(op){const c=structuredClone(rows);const r=op(c);rows=c;return r;}};
  const c=createPaymentCore({store,adapters:[adapter],key:()=>ownerKey(pair.publicKey.export({type:"spki",format:"pem"})),
    timeouts:{quoteMs:PAYMENT_QUOTE_TIMEOUT_MS,executionMs:PAYMENT_EXECUTION_TIMEOUT_MS,resumeMs:PAYMENT_RESUME_TIMEOUT_MS}});
  return {core:c,runs,cleanup:()=>fs.rmSync(tmp,{recursive:true,force:true})};
}

test("a provider slowed to 35 s still returns its quote through every layer",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=core(35000);
  try{
    const pending=f.core.localQuote("maxit.topup",reference);
    await new Promise(r=>setImmediate(r));
    t.mock.timers.tick(35000);
    assert.deepEqual(await pending,quote);
    assert.deepEqual(f.runs,[MAXIT_QUOTE_RUN_TIMEOUT_MS]);
  }finally{f.cleanup();}
});

test("a provider slower than its budget fails at the adapter, inside the core bound",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=core(50000);
  try{
    const pending=f.core.localQuote("maxit.topup",reference);
    await new Promise(r=>setImmediate(r));
    t.mock.timers.tick(MAXIT_QUOTE_RUN_TIMEOUT_MS);
    await assert.rejects(pending,e=>e.message==="maxit_topup_runner_timeout"); // not payment_adapter_timeout
  }finally{f.cleanup();}
});
