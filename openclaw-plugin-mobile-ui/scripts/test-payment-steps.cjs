// P0-8 (lot paiement Maxit 11/10): a pre-payment failure is never silent. Each step before the
// PaymentRecord is traced on the existing confirmation record (no new store) and served to the app.
// No real provider, network or payment: the Maxit live runner cannot exist in the test state dir.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path"),http=require("http"),crypto=require("crypto");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"payment-steps-"));
process.env.OPENCLAW_STATE_DIR=root;
process.env.HOME=root; // the Maxit adapter's ui-playbooks root resolves under an empty home
const dir=path.join(root,"clawmobile-companion");fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,"maxit-topup-live-acceptance.enabled"),"maxit-topup-v1-live-acceptance\n");
const keys=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
fs.writeFileSync(path.join(dir,"owner-confirmation-public.pem"),keys.publicKey.export({type:"spki",format:"pem"}));
const {route}=require("../dist/companion/server.js");
const {confirmations}=require("../dist/companion/confirmations.js");
const {buildLocalPaymentIntent}=require("../dist/companion/localPaymentIntent.js");
const {compactPaymentUiView,latestPaymentStep}=require("../dist/companion/payments.js");
const headers={"X-ClawMobile-Owner-Flow":"v1","Content-Type":"application/json"};
const quote={payee:"Orange Maxit ••••1234",reference:"topup-"+"a".repeat(32)+"-"+"b".repeat(32)+"-5000",amountMinor:5000,currency:"TND",decimals:3};
let base,server;
async function req(url,method="GET",body){const r=await fetch(base+url,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return {code:r.status,body:await r.json()};}
async function approve(id){
  const c=(await req("/v1/confirmations/"+id+"/challenge")).body;
  const proof={keyId:c.keyId,nonce:c.nonce,bindingHash:c.bindingHash,signature:crypto.sign("sha256",Buffer.from(c.challenge),keys.privateKey).toString("base64")};
  assert.equal((await req("/v1/confirmations/"+id+"/owner-confirmation","POST",proof)).body.approved,true);
}
test.before(async()=>{
  server=http.createServer((q,s)=>route(q,s).catch(e=>{s.statusCode=e.statusCode||500;s.end(JSON.stringify({message:e.message}))}));
  await new Promise(r=>server.listen(0,"127.0.0.1",r));base="http://127.0.0.1:"+server.address().port;
});
test.after(()=>{server.close();fs.rmSync(root,{recursive:true,force:true});});

test("handoff records its step; an unapproved local start records the refusal step",async()=>{
  const h=await req("/v1/payments/local-handoffs","POST",{requestKey:crypto.randomUUID(),adapterId:"maxit.topup",quote,origin:{channel:"claw",id:"turn-steps"},notify:false});
  assert.equal(h.code,200);
  const id=h.body.confirmationRequestId;
  assert.deepEqual((await req("/v1/payments/local-intents/"+id)).body.lastStep,{stage:"handoff_prepared"});
  const refused=await req("/v1/payments/local-start","POST",{confirmationRequestId:id});
  assert.equal(refused.code,409);
  const status=(await req("/v1/payments/local-intents/"+id)).body;
  assert.equal(status.financialSubmissionAttempted,false);
  assert.deepEqual(status.lastStep,{stage:"owner_confirmation",reasonCode:"local_start_confirmation_not_approved"});
});

test("an approved start whose fresh quote fails records quote_revalidation with its code, before any PaymentRecord",async()=>{
  const intent=buildLocalPaymentIntent({adapterId:"maxit.topup",quote,origin:{channel:"claw",id:"turn-steps-2"}});
  const prepared=await confirmations.prepare({requestKey:crypto.randomUUID(),action:intent.action,presentation:intent.presentation,origin:intent.origin});
  await approve(prepared.requestId);
  const refused=await req("/v1/payments/local-start","POST",{confirmationRequestId:prepared.requestId});
  assert.notEqual(refused.code,200);
  const status=(await req("/v1/payments/local-intents/"+prepared.requestId)).body;
  assert.equal(status.state,"approved"); // not consumed: nothing dispatched
  assert.equal(status.financialSubmissionAttempted,false);
  assert.equal(status.lastStep.stage,"quote_revalidation");
  assert.match(status.lastStep.reasonCode,/^[a-z0-9_]{1,96}$/);
});

test("steps are bounded and never alter the signed binding",async()=>{
  const intent=buildLocalPaymentIntent({adapterId:"maxit.topup",quote,origin:{channel:"claw",id:"turn-steps-3"}});
  const prepared=await confirmations.prepare({requestKey:crypto.randomUUID(),action:intent.action,presentation:intent.presentation,origin:intent.origin});
  const before=(await confirmations.status(prepared.requestId)).bindingHash;
  for(let i=0;i<30;i++)await confirmations.recordStep(prepared.requestId,{stage:"quote_revalidation",reasonCode:"r"+i});
  await assert.rejects(confirmations.recordStep(prepared.requestId,{stage:"quote_revalidation",reasonCode:"Free text 4111"}));
  await assert.rejects(confirmations.recordStep(prepared.requestId,{stage:"invented_stage"}));
  assert.equal((await confirmations.status(prepared.requestId)).bindingHash,before);
  assert.deepEqual(await confirmations.lastStep(prepared.requestId),{stage:"quote_revalidation",reasonCode:"r29",at:(await confirmations.lastStep(prepared.requestId)).at});
});

test("after the PaymentRecord, the app view carries the precise last step (reasonDetail kept)",()=>{
  const payment={schemaVersion:1,requestId:crypto.randomUUID(),adapterId:"maxit.topup",state:"blocked",reasonCode:"payment_not_submitted",quote,
    financialSubmissionAttempted:true,timeline:[
      {seq:1,at:1,stage:"owner_confirmation_consumed"},
      {seq:2,at:2,stage:"execution_error",reasonCode:"maxit_order_creation_failed",reasonDetail:"maxit_order_creation_failed"},
      {seq:3,at:3,stage:"http_exchange",http:{}},
      {seq:4,at:4,stage:"state_transition",outcome:"blocked",reasonCode:"payment_not_submitted",reasonDetail:"maxit_order_creation_failed"}]};
  const view=compactPaymentUiView(payment);
  assert.deepEqual(view.lastStep,{stage:"execution_error",reasonCode:"payment_not_submitted",reasonDetail:"maxit_order_creation_failed"});
  assert.equal(latestPaymentStep({timeline:[]}),null);
});

test("GET /payments/{id}?view=compact is a bounded projection without the forensic timeline",async()=>{
  const draft={requestKey:crypto.randomUUID(),adapterId:"demo.confirmation",reference:"DEMO",mode:"demo",origin:{channel:"work",id:"compact"}};
  const r=await req("/v1/payments","POST",draft);assert.equal(r.code,200);
  const full=(await req("/v1/payments/"+r.body.requestId)).body;
  const compact=(await req("/v1/payments/"+r.body.requestId+"?view=compact")).body;
  assert.ok("timeline" in full);assert.equal("timeline" in compact,false);
  assert.equal(compact.state,full.state);assert.ok(Buffer.byteLength(JSON.stringify(compact))<16384);
  const refused=await fetch(base+"/v1/payments/"+r.body.requestId+"?view=compact");assert.equal(refused.status,403);
});
