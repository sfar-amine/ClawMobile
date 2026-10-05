const {test}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("crypto");
const {validateLocalHandoffInput,localHandoffNotificationArgs}=require("../dist/companion/payments.js");
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
