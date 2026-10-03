const assert=require("assert/strict"),crypto=require("crypto");
const {createPaymentCore,ownerKey,confirmationMessage,quoteDigest}=require("../dist/companion/paymentCore.js");
let count=0;
async function test(name,fn){await fn();count++;console.log("PASS "+name)}
function fixture({mode="demo",execute,revalidate,quote,validated=true,timeouts}={}){
 const pair=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
 const key=ownerKey(pair.publicKey.export({type:"spki",format:"pem"}));
 let rows=[],clock=1000000,calls=0,writes=Promise.resolve();
 const store={async read(){await writes;return structuredClone(rows)},change(op){
  const next=writes.then(()=>{const copy=structuredClone(rows);const result=op(copy);rows=copy;return result});
  writes=next.then(()=>{},()=>{});return next;
 }};
 const q={payee:"Marchand de test",reference:"DEMO",amountMinor:mode==="demo"?0:2345,currency:"TND",decimals:3};
 const adapter={id:"fixture.payment",label:"Synthetic adapter",mode,executionValidated:validated,
  quote:quote||asyncRef,revalidate:revalidate||(async value=>({...value})),async execute(...args){calls++;return execute?execute(...args):{state:"confirmed",reasonCode:"gateway_and_provider_confirmed",receipt:{reference:"TEST-RECEIPT",transactionCorrelated:true,providerReconciled:true}}}};
 async function asyncRef(reference){return {...q,reference}}
 const make=()=>createPaymentCore({store,adapters:[adapter],key:()=>key,clock:()=>clock,timeouts});
 const core=make();
 const draft=()=>({requestKey:crypto.randomUUID(),adapterId:adapter.id,reference:"DEMO",mode,origin:{channel:"work",id:"fixture-conversation"}});
 async function prepared(){return core.prepare(draft())}
 async function proof(id){const c=await core.challenge(id);return {keyId:c.keyId,nonce:c.nonce,quoteHash:c.quoteHash,
  signature:crypto.sign("sha256",Buffer.from(c.challenge),pair.privateKey).toString("base64")}}
 return {core,make,draft,prepared,proof,store,key,adapter,pair,calls:()=>calls,setTime:t=>clock=t,time:()=>clock,setRows:v=>rows=v};
}
const reject=(fn,code)=>assert.rejects(fn,e=>e.message===code);
(async()=>{
 await test("demo confirmation is explicitly not a payment",async()=>{const f=fixture(),r=await f.prepared();f.setTime(f.time()+500);
  const out=await f.core.confirm(r.requestId,await f.proof(r.requestId));assert.equal(out.state,"demo_confirmed");assert.equal(out.financialSubmissionAttempted,false);
  assert.equal(out.metrics.ownerWaitMs,500);assert.equal(f.calls(),1);assert.equal(out.canRetry,false)});
 await test("strict draft denies unexpected secrets and raw URLs",async()=>{const f=fixture();await reject(()=>f.core.prepare({...f.draft(),card:"never-accepted"}),"invalid_payment_request");assert.equal(f.calls(),0)});
 await test("unknown adapter stops before quote",async()=>{const f=fixture();await reject(()=>f.core.prepare({...f.draft(),adapterId:"unknown.adapter"}),"payment_adapter_unavailable")});
 await test("unvalidated provider stops before quote",async()=>{const f=fixture({mode:"live",validated:false,quote:async()=>{throw Error("must_not_run")}});await reject(()=>f.prepared(),"payment_contract_unverified")});
 await test("demo cannot be switched into live mode",async()=>{const f=fixture();await reject(()=>f.core.prepare({...f.draft(),mode:"live"}),"payment_adapter_mode_mismatch")});
 await test("request key is idempotent despite JSON field ordering",async()=>{const f=fixture(),d=f.draft(),a=await f.core.prepare(d);
  const b=await f.core.prepare({origin:{id:d.origin.id,channel:d.origin.channel},mode:d.mode,reference:d.reference,adapterId:d.adapterId,requestKey:d.requestKey});
  assert.equal(a.requestId,b.requestId);assert.equal((await f.store.read()).length,1)});
 await test("request key substitution conflicts",async()=>{const f=fixture(),d=f.draft();await f.core.prepare(d);await reject(()=>f.core.prepare({...d,reference:"OTHER"}),"payment_request_key_conflict")});
 await test("raw boolean approval cannot authorize",async()=>{const f=fixture(),r=await f.prepared();await reject(()=>f.core.confirm(r.requestId,{approved:true}),"invalid_payment_request");assert.equal(f.calls(),0)});
 await test("foreign signing key rejected",async()=>{const f=fixture(),r=await f.prepared(),p=await f.proof(r.requestId),other=fixture();p.signature=crypto.sign("sha256",Buffer.from("wrong"),other.pair.privateKey).toString("base64");
  await reject(()=>f.core.confirm(r.requestId,p),"invalid_owner_proof");assert.equal(f.calls(),0)});
 await test("request nonce substitution rejected",async()=>{const f=fixture(),r=await f.prepared(),p=await f.proof(r.requestId);p.nonce="a".repeat(64);
  await reject(()=>f.core.confirm(r.requestId,p),"invalid_owner_proof");assert.equal(f.calls(),0)});
 await test("quote substitution rejected",async()=>{const f=fixture(),r=await f.prepared(),p=await f.proof(r.requestId);p.quoteHash="b".repeat(64);
  await reject(()=>f.core.confirm(r.requestId,p),"invalid_owner_proof")});
 await test("proof bound to one request",async()=>{const f=fixture(),a=await f.prepared(),b=await f.prepared();await reject(async()=>f.core.confirm(b.requestId,await f.proof(a.requestId)),"invalid_owner_proof")});
 await test("parallel confirmations dispatch exactly once",async()=>{const f=fixture(),r=await f.prepared(),p=await f.proof(r.requestId);
  const out=await Promise.allSettled([f.core.confirm(r.requestId,p),f.core.confirm(r.requestId,p)]);
  assert.equal(out.filter(x=>x.status==="fulfilled").length,1);assert.equal(f.calls(),1)});
 await test("expiry blocks and records expiration",async()=>{const f=fixture(),r=await f.prepared(),p=await f.proof(r.requestId);f.setTime(f.time()+120000);
  await reject(()=>f.core.confirm(r.requestId,p),"payment_confirmation_already_consumed");assert.equal((await f.core.status(r.requestId)).state,"expired");assert.equal(f.calls(),0)});
 await test("clock rollback invalidates pending authorization",async()=>{const f=fixture(),r=await f.prepared();f.setTime(1);assert.equal((await f.core.status(r.requestId)).state,"expired")});
 await test("owner cancellation does not dispatch",async()=>{const f=fixture(),r=await f.prepared();await f.core.cancel(r.requestId);await reject(()=>f.core.challenge(r.requestId),"payment_request_not_pending");assert.equal(f.calls(),0)});
 await test("amount change after gesture blocks submission",async()=>{const f=fixture({revalidate:async q=>({...q,amountMinor:999})}),r=await f.prepared();
  const out=await f.core.confirm(r.requestId,await f.proof(r.requestId));assert.equal(out.state,"blocked");assert.equal(out.reasonCode,"payment_quote_changed");assert.equal(f.calls(),0)});
 await test("reference change after gesture blocks submission",async()=>{const f=fixture({revalidate:async q=>({...q,reference:"OTHER"})}),r=await f.prepared();
  assert.equal((await f.core.confirm(r.requestId,await f.proof(r.requestId))).state,"blocked");assert.equal(f.calls(),0)});
 await test("lost execution response is unknown and not retryable",async()=>{const f=fixture({execute:async()=>{throw Error("timeout")}}),r=await f.prepared(),p=await f.proof(r.requestId);
  const out=await f.core.confirm(r.requestId,p);assert.equal(out.state,"effect_unknown");await reject(()=>f.core.confirm(r.requestId,p),"payment_confirmation_already_consumed");assert.equal(f.calls(),1)});
 await test("provider revalidation failure never dispatches",async()=>{const f=fixture({revalidate:async()=>{throw Error("offline")}}),r=await f.prepared();
  const out=await f.core.confirm(r.requestId,await f.proof(r.requestId));assert.equal(out.reasonCode,"payment_revalidation_failed");assert.equal(f.calls(),0)});
 await test("synthetic live success requires correlated receipt",async()=>{const f=fixture({mode:"live"}),r=await f.prepared();
  const out=await f.core.confirm(r.requestId,await f.proof(r.requestId));assert.equal(out.state,"confirmed");assert.equal(out.receipt.reference,"TEST-RECEIPT")});
 await test("success without receipt becomes unknown",async()=>{const f=fixture({mode:"live",execute:async()=>({state:"confirmed",reasonCode:"gateway_and_provider_confirmed"})}),r=await f.prepared();
  assert.equal((await f.core.confirm(r.requestId,await f.proof(r.requestId))).reasonCode,"payment_receipt_unverified")});
 await test("live duplicate reference is guarded across request keys",async()=>{const f=fixture({mode:"live"});await f.prepared();await reject(()=>f.prepared(),"payment_for_reference_already_guarded")});
 await test("unknown live effect prevents fresh request key replay",async()=>{const f=fixture({mode:"live",execute:async()=>{throw Error("timeout")}}),r=await f.prepared();
  await f.core.confirm(r.requestId,await f.proof(r.requestId));await reject(()=>f.prepared(),"payment_for_reference_already_guarded")});
 await test("restart never resumes an interrupted dispatch",async()=>{let finish;const f=fixture({execute:()=>new Promise(resolve=>finish=resolve)}),r=await f.prepared(),proof=await f.proof(r.requestId);
  const pending=f.core.confirm(r.requestId,proof);while(!finish)await new Promise(resolve=>setImmediate(resolve));
  const restarted=f.make();assert.equal((await restarted.status(r.requestId)).reasonCode,"execution_interrupted");
  finish({state:"confirmed",reasonCode:"gateway_and_provider_confirmed"});await pending;assert.equal((await restarted.status(r.requestId)).state,"effect_unknown");assert.equal(f.calls(),1)});
 await test("cancel after dispatch never pretends bank cancellation",async()=>{let finish;const f=fixture({execute:()=>new Promise(resolve=>finish=resolve)}),r=await f.prepared();
  const pending=f.core.confirm(r.requestId,await f.proof(r.requestId));while(!finish)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.core.cancel(r.requestId)).state,"executing");finish({state:"confirmed",reasonCode:"gateway_and_provider_confirmed"});await pending;assert.equal(f.calls(),1)});
 await test("control characters rejected in trusted quotes",async()=>{const f=fixture({quote:async()=>({payee:"Wrong\\nPayee",reference:"DEMO",amountMinor:0,currency:"TND",decimals:3})});
  // An actual newline, not the literal two-character escape, is rejected.
  f.adapter.quote=async()=>({payee:"Wrong\nPayee",reference:"DEMO",amountMinor:0,currency:"TND",decimals:3});await reject(()=>f.prepared(),"invalid_payment_quote")});
 await test("status never exposes signature or nonce",async()=>{const f=fixture(),r=await f.prepared();assert.equal("nonce" in r,false);assert.equal("signature" in r,false);assert.equal("keyId" in r,false)});

 await test("unverified rejection remains unknown",async()=>{const f=fixture({mode:"live",execute:async()=>({state:"failed",reasonCode:"bank_declined"})}),r=await f.prepared();
  assert.equal((await f.core.confirm(r.requestId,await f.proof(r.requestId))).reasonCode,"payment_rejection_unverified")});
 await test("verified rejection can report failure",async()=>{const f=fixture({mode:"live",execute:async()=>({state:"failed",reasonCode:"bank_declined",rejectionVerified:true})}),r=await f.prepared();
  assert.equal((await f.core.confirm(r.requestId,await f.proof(r.requestId))).state,"failed")});
 await test("inconsistent status and reason remain unknown",async()=>{const f=fixture({mode:"live",execute:async()=>({state:"confirmed",reasonCode:"bank_declined"})}),r=await f.prepared();
  assert.equal((await f.core.confirm(r.requestId,await f.proof(r.requestId))).reasonCode,"invalid_payment_adapter_result")});
 await test("hanging quote is bounded",async()=>{const f=fixture({quote:()=>new Promise(()=>{}),timeouts:{quoteMs:5}});
  await reject(()=>f.prepared(),"payment_adapter_timeout");assert.equal(f.calls(),0)});
 await test("hanging execution is unknown with no replay",async()=>{const f=fixture({execute:()=>new Promise(()=>{}),timeouts:{executionMs:5}}),r=await f.prepared(),p=await f.proof(r.requestId);
  assert.equal((await f.core.confirm(r.requestId,p)).state,"effect_unknown");await reject(()=>f.core.confirm(r.requestId,p),"payment_confirmation_already_consumed");assert.equal(f.calls(),1)});
 await test("authorization expiring during revalidation cannot dispatch",async()=>{const f=fixture(),r=await f.prepared();
  f.adapter.revalidate=async q=>{f.setTime(f.time()+120000);return q};
  assert.equal((await f.core.confirm(r.requestId,await f.proof(r.requestId))).state,"blocked");assert.equal(f.calls(),0)});
 await test("nonstring draft identifiers rejected",async()=>{const f=fixture(),d=f.draft();
  await reject(()=>f.core.prepare({...d,requestKey:[d.requestKey]}),"invalid_payment_request");
  await reject(()=>f.core.prepare({...d,adapterId:[d.adapterId]}),"invalid_payment_request")});
 await test("total duration includes preparation",async()=>{const f=fixture(),quote=f.adapter.quote;
  f.adapter.quote=async ref=>{f.setTime(f.time()+125);return quote(ref)};
  const r=await f.prepared();f.setTime(f.time()+500);
  const out=await f.core.confirm(r.requestId,await f.proof(r.requestId));
  assert.equal(out.metrics.preparationMs,125);assert.equal(out.metrics.totalMs,625)});
 console.log("PAYMENT_CORE_TESTS_PASSED="+count);
})().catch(e=>{console.error(e);process.exitCode=1});
