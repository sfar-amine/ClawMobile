// S24 06/11 23:52 (first live SONEDE attempt): the one-shot acceptance gate was consumed by the start, then the
// bank's rejectpay return and the 60 s timeout reconciliation were both refused (local_owner_payment_contract_unverified)
// and the record stayed requires_bank_action. Continuing the SAME dispatched record must work without the gate;
// starting a new payment must still require it.
const assert=require("assert/strict"),crypto=require("crypto");
const {createHash}=crypto;
const {createPaymentCore,BANK_ACTION_TIMEOUT_MS}=require("../dist/companion/paymentCore.js");
let count=0;
async function test(name,fn){await fn();count++;console.log("PASS "+name)}
const reject=(fn,code)=>assert.rejects(fn,e=>e.message===code);
const QUOTE={payee:"SONEDE",reference:"312854662",amountMinor:19400,currency:"TND",decimals:3};
const CONT={provider:"sonede",checkoutId:"33093561748662981898171417192",gatewayOrderId:"5a71970b-ae5e-43bb-b80c-ed79ba361574"};
function fixture({resume}={}){
  const rows=[];let clock=2000000,armed=true,token=null,starts=0,resumes=0,quotes=0;
  const store={async read(){return structuredClone(rows)},change(op){return op(rows)}};
  const pair=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const kid=createHash("sha256").update(pair.publicKey.export({type:"spki",format:"der"})).digest("hex");
  const adapter={id:"sonede",label:"SONEDE",mode:"live",executionValidated:false,unavailableReason:"x",
    quote:async ref=>{quotes++;return {...QUOTE,reference:ref}},revalidate:async q=>q,
    execute:async()=>{throw Error("external_path_must_not_run")},
    // Same as clicToPayLivePaymentAdapter with localRequiresGate: the start consumes the one-shot gate.
    executeLocal:async(_q,_id,ctx)=>{starts++;armed=false;token=ctx.bankReturnToken;
      return {state:"requires_bank_action",reasonCode:"bank_verification_required",continuation:CONT}},
    resume:async(...args)=>{resumes++;return resume?resume(...args):{state:"failed",reasonCode:"payment_cancelled",rejectionVerified:true}}};
  Object.defineProperty(adapter,"localOwnerValidated",{enumerable:true,get:()=>armed});
  const core=createPaymentCore({store,adapters:[adapter],key:()=>({key:pair.publicKey,id:kid}),clock:()=>clock});
  const start=(reference=QUOTE.reference)=>core.startLocalAuthorized({confirmationRequestId:crypto.randomUUID(),adapterId:"sonede",
    reference,quote:{...QUOTE,reference}});
  return {core,start,token:()=>token,starts:()=>starts,resumes:()=>resumes,quotes:()=>quotes,armed:()=>armed,
    rearm:()=>{armed=true},advance:ms=>{clock+=ms}};
}
(async()=>{
  await test("bank return after the gate was consumed reaches the provider readback and ends the record",async()=>{
    const f=fixture();const out=await f.start();
    assert.equal(out.state,"requires_bank_action");assert.equal(f.armed(),false);
    const done=await f.core.resumeFromBankReturn(out.requestId,f.token());
    assert.equal(f.resumes(),1);assert.equal(f.starts(),1,"never a second submission");
    assert.notEqual(done.state,"requires_bank_action");
    assert.ok(["failed","cancelled"].includes(done.state),done.state);
    assert.equal(done.timeline.some(e=>e.stage==="bank_resume_started"),true);
  });
  await test("a confirmed provider result after the gate was consumed is applied (success path)",async()=>{
    const f=fixture({resume:async()=>({state:"confirmed",reasonCode:"gateway_and_provider_confirmed",
      receipt:{reference:"internal-sonede-x",transactionCorrelated:true,providerReconciled:true}})});
    const out=await f.start();const done=await f.core.resumeFromBankReturn(out.requestId,f.token());
    assert.equal(done.state,"confirmed");assert.equal(f.starts(),1);
  });
  await test("timeout reconciliation after the gate was consumed reads the invoice and closes as cancelled",async()=>{
    const f=fixture();const out=await f.start();
    f.advance(BANK_ACTION_TIMEOUT_MS-1);await reject(()=>f.core.timeoutBankAction(out.requestId),"payment_bank_timeout_not_available");
    f.advance(1);const done=await f.core.timeoutBankAction(out.requestId);
    assert.equal(done.state,"cancelled");assert.equal(done.reasonCode,"payment_cancelled");
    assert.equal(f.quotes(),1);assert.equal(f.starts(),1);
  });
  await test("a NEW payment still requires the armed gate (and the pending one keeps its reference guarded)",async()=>{
    const f=fixture();await f.start();
    await reject(()=>f.start("312844490"),"local_owner_payment_contract_unverified");assert.equal(f.starts(),1);
    f.rearm();
    await reject(()=>f.start(),"payment_for_reference_already_guarded");
    const again=await f.start("312844490");assert.equal(again.state,"requires_bank_action");assert.equal(f.starts(),2);
  });
  await test("the bank return token stays single-use",async()=>{
    const f=fixture();const out=await f.start();const token=f.token();
    await f.core.resumeFromBankReturn(out.requestId,token);
    await reject(()=>f.core.resumeFromBankReturn(out.requestId,token),"payment_bank_return_not_available");
    assert.equal(f.resumes(),1);
  });
  console.log(`payment gate continuation: ${count} PASS`);
})().catch(error=>{console.error(error);process.exit(1)});
