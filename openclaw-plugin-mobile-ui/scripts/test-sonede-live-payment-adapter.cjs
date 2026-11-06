// SONEDE live payment adapter: off by default, one-shot marker on every path, provider identity end to end.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path");
const {createSonedeLivePaymentAdapter}=require("../dist/companion/sonedeLivePaymentAdapter.js");
const {createTopnetLivePaymentAdapter}=require("../dist/companion/topnetLivePaymentAdapter.js");

const requestId="11111111-1111-4111-8111-111111111111";
const bankReturnToken="B".repeat(43);
const continuation={provider:"sonede",checkoutId:"33015479813727497203105546241",gatewayOrderId:"22222222-2222-4222-8222-222222222222"};

function harness(){
 const tmp=path.join(os.homedir(),".cache","claw-tests");fs.mkdirSync(tmp,{recursive:true});
 const root=fs.mkdtempSync(path.join(tmp,"sonede-payment-adapter-")),billing=path.join(root,"billing"),state=path.join(root,"state");
 fs.mkdirSync(path.join(state,"clawmobile-companion"),{recursive:true});
 const marker=path.join(state,"clawmobile-companion","sonede-live-acceptance.enabled");
 const calls=[];
 const exec=async(_file,args)=>{
  calls.push(["exec",...args]);const script=String(args[0]);
  if(script.endsWith("billing-cli.mjs")){
   assert.equal(args[1],"sonede");
   return {stderr:"",stdout:JSON.stringify({coverage_complete:true,providers:[{provider:"sonede",coverage_complete:true,currency:"TND",items:[{provider_invoice_id:"900000001",amount_pending_millimes:19400,currency:"TND"}]}]})};
  }
  if(script.endsWith("payment-card-cli.mjs"))return {stderr:"",stdout:JSON.stringify({state:"ready",last4:"8503",cvc_stored:true})};
  throw Error("unexpected_exec");
 };
 const liveRun=async(_script,payload)=>{
  calls.push(["live",payload]);
  if(payload.operation==="start")return {state:"requires_bank_action",reason_code:"bank_verification_required",continuation};
  return {state:"confirmed",gateway_return_correlated:true,fresh_provider_read:true,invoice_state:"settled"};
 };
 const adapter=createSonedeLivePaymentAdapter({billingRoot:billing,stateDir:state,exec,liveRun});
 return {adapter,calls,marker,arm:()=>fs.writeFileSync(marker,"sonede-v1-live-acceptance\n"),done:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test("SONEDE is off without its marker: not offered, nothing sent",async()=>{
 const h=harness();
 try{
  assert.equal(h.adapter.id,"sonede");assert.equal(h.adapter.mode,"live");assert.equal(h.adapter.executionValidated,false);
  assert.equal(h.adapter.localOwnerValidated,false);
  assert.ok(h.adapter.bankNavigationOrigins.includes("https://portail.sonede.com.tn"));
  const quote=await h.adapter.quote("900000001");
  assert.deepEqual(quote,{payee:"SONEDE",reference:"900000001",amountMinor:19400,currency:"TND",decimals:3});
  for(const run of [()=>h.adapter.executeLocal(quote,requestId,{bankReturnToken}),()=>h.adapter.execute(quote,requestId,{bankReturnToken})])
   assert.deepEqual(await run(),{state:"blocked",reasonCode:"payment_not_submitted"});
  assert.equal(h.calls.filter(c=>c[0]==="live").length,0);
  assert.ok(!h.calls.some(c=>String(c[1]).endsWith("payment-card-cli.mjs")));
 }finally{h.done();}
});

test("armed marker allows exactly one owner-confirmed start, then SONEDE is off again",async()=>{
 const h=harness();
 try{
  h.arm();assert.equal(h.adapter.localOwnerValidated,true);
  const quote=await h.adapter.quote("900000001");
  const started=await h.adapter.executeLocal(quote,requestId,{bankReturnToken});
  assert.equal(started.state,"requires_bank_action");assert.deepEqual(started.continuation,continuation);
  const start=h.calls.find(c=>c[0]==="live")[1];
  assert.equal(start.provider,"sonede");assert.equal(start.operation,"start");
  assert.deepEqual(start.request,{invoice_id:"900000001",expected_amount_millimes:19400,currency:"TND",expected_last4:"8503"});
  assert.equal(fs.existsSync(h.marker),false);assert.equal(h.adapter.localOwnerValidated,false);
  assert.deepEqual(await h.adapter.executeLocal(quote,requestId,{bankReturnToken}),{state:"blocked",reasonCode:"payment_not_submitted"});
  assert.equal(h.calls.filter(c=>c[0]==="live"&&c[1].operation==="start").length,1);
  // Resume of the same payment needs no marker and confirms only with correlated return and settled readback.
  const done=await h.adapter.resume(quote,requestId,continuation);
  assert.equal(done.state,"confirmed");assert.equal(done.receipt.reference,"internal-sonede-"+requestId);
 }finally{h.done();}
});

test("a wrong marker value never arms SONEDE",async()=>{
 const h=harness();
 try{
  fs.writeFileSync(h.marker,"topnet-v1-live-acceptance");
  assert.equal(h.adapter.localOwnerValidated,false);
  const quote=await h.adapter.quote("900000001");
  assert.deepEqual(await h.adapter.executeLocal(quote,requestId,{bankReturnToken}),{state:"blocked",reasonCode:"payment_not_submitted"});
  assert.equal(h.calls.filter(c=>c[0]==="live").length,0);
 }finally{h.done();}
});

test("references are SONEDE invoice digits only; continuations of other providers are refused",async()=>{
 const h=harness();
 try{
  await assert.rejects(h.adapter.quote("U-42"),/invalid_provider_reference/);
  const out=await h.adapter.resume({payee:"SONEDE",reference:"900000001",amountMinor:1,currency:"TND",decimals:3},requestId,{...continuation,provider:"topnet"});
  assert.deepEqual(out,{state:"effect_unknown",reasonCode:"payment_effect_unverified"});
 }finally{h.done();}
});

test("Topnet keeps its constant owner path unchanged",()=>{
 const topnet=createTopnetLivePaymentAdapter({exec:async()=>{throw Error("unused")},liveRun:async()=>{throw Error("unused")}});
 assert.equal(topnet.localOwnerValidated,true);
 assert.equal(Object.getOwnPropertyDescriptor(topnet,"localOwnerValidated").get,undefined);
});
