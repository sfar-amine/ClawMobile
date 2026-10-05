const {test}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("crypto");
const {validateLocalHandoffInput,localHandoffNotificationArgs,compactPaymentUiView}=require("../dist/companion/payments.js");
const id="11111111-1111-4111-8111-111111111111";
const quote={payee:"TOPNET",reference:"INV-1",amountMinor:60900,currency:"TND",decimals:3};

test("local handoff accepts only inert quote/origin fields",()=>{
 const v=validateLocalHandoffInput({requestKey:id,adapterId:"topnet",quote,origin:{channel:"chatgpt",id:"turn-1"},notify:true});
 assert.deepEqual(v,{requestKey:id,adapterId:"topnet",quote,origin:{channel:"chatgpt",id:"turn-1"},notify:true});
 for(const extra of [{mode:"live"},{card:"never"},{cvc:"000"},{gatewayOrderId:crypto.randomUUID()}])
  assert.throws(()=>validateLocalHandoffInput({requestKey:id,adapterId:"topnet",quote,origin:{channel:"chatgpt",id:"turn-1"},notify:true,...extra}));
});

test("handoff notification is passive and contains only safe display data",()=>{
 const args=localHandoffNotificationArgs(id,quote),joined=args.join(" ");
 assert.match(joined,/Samantha · Paiement/);assert.match(joined,/TOPNET · 60,900 TND/);
 assert.equal(args.includes("--action"),false);assert.equal(joined.includes(id),false);assert.equal(/toucher|autoriser/i.test(joined),false);
 for(const forbidden of ["INV-1","cvc","otp","cookie","gatewayOrderId"])assert.equal(joined.toLowerCase().includes(forbidden.toLowerCase()),false);
});

test("compact Android payment projection omits timeline but keeps current progress and result",()=>{
 const timeline=Array.from({length:120},(_,i)=>({seq:i+1,at:1000+i,stage:"http_exchange",http:{method:"GET"}}));
 timeline.push({seq:121,at:2200,stage:"invoice_revalidated",invoiceState:"unpaid"});
 const payment={schemaVersion:1,requestId:id,adapterId:"topnet",state:"executing",reasonCode:"owner_confirmed_local",
  quote,financialSubmissionAttempted:true,timeline,receipt:undefined};
 const view=compactPaymentUiView(payment);
 assert.equal(view.requestId,id);assert.equal(view.state,"executing");
 assert.deepEqual(view.progress,{stage:"invoice_revalidated",invoiceState:"unpaid",at:2200});
 assert.equal("timeline" in view,false);
 assert.ok(Buffer.byteLength(JSON.stringify(view))<4096);
});
