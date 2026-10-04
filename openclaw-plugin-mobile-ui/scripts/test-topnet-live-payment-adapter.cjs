const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path");
const {createTopnetLivePaymentAdapter}=require("../dist/companion/topnetLivePaymentAdapter.js");

const invoice="20263531507";
const requestId="11111111-1111-4111-8111-111111111111";
const context={bankReturnToken:"A".repeat(43)};
const continuation={provider:"topnet",checkoutId:"12345",gatewayOrderId:"22222222-2222-4222-8222-222222222222"};

function fixture({enabled=true,startResult,resumeResult,startEvents=[]}={}){
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
 const liveRun=async(_script,payload,timeoutMs,onEvent)=>{
  liveCalls++;calls.push(["live",payload,timeoutMs]);
  if(payload.operation==="resume")return resumeResult??{state:"confirmed",gateway_return_correlated:true,fresh_provider_read:true,invoice_state:"settled"};
  for(const event of startEvents)if(onEvent)await onEvent(event);
  return startResult??{state:"requires_bank_action",reason_code:"bank_verification_required",continuation};
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

test("FORM1 stage returns durable continuation after exactly one live dispatch",async()=>{
 const f=fixture();
 try{
  const q=await f.adapter.quote(invoice);
  const result=await f.adapter.execute(q,requestId,context);
  assert.deepEqual(result,{state:"requires_bank_action",reasonCode:"bank_verification_required",continuation});
  assert.equal(f.liveCalls(),1);
  const payload=f.calls.find(x=>x[0]==="live")[1];
  assert.equal(payload.operation,"start");
  assert.equal(payload.paymentRequestId,requestId);
  assert.equal(payload.bankReturnToken,context.bankReturnToken);
  assert.deepEqual(payload.request,{invoice_id:invoice,expected_amount_millimes:60900,currency:"TND",expected_last4:"8503"});
  assert.equal(f.calls.find(x=>x[0]==="live")[2],225000);
 }finally{f.cleanup();}
});

test("acceptance gate is consumed before the only FORM1 dispatch",async()=>{
 const f=fixture();
 try{
  const q=await f.adapter.quote(invoice);
  assert.equal((await f.adapter.execute(q,requestId,context)).state,"requires_bank_action");
  assert.equal((await f.adapter.execute(q,"33333333-3333-4333-8333-333333333333",context)).state,"effect_unknown");
  assert.equal(f.liveCalls(),1);
 }finally{f.cleanup();}
});

test("resume is read-only and does not consume a new gate or card status",async()=>{
 const f=fixture();
 try{
  const q=await f.adapter.quote(invoice);
  await f.adapter.execute(q,requestId,context);
  const beforeCard=f.calls.filter(x=>x[0]==="exec"&&String(x[1]).endsWith("payment-card-cli.mjs")).length;
  const out=await f.adapter.resume(q,requestId,continuation);
  assert.equal(out.state,"confirmed");
  assert.equal(out.reasonCode,"gateway_and_provider_confirmed");
  const afterCard=f.calls.filter(x=>x[0]==="exec"&&String(x[1]).endsWith("payment-card-cli.mjs")).length;
  assert.equal(afterCard,beforeCard);
  const resumePayload=f.calls.filter(x=>x[0]==="live").at(-1)[1];
  assert.equal(resumePayload.operation,"resume");
  assert.deepEqual(resumePayload.continuation,continuation);
  assert.deepEqual(resumePayload.request,{invoice_id:invoice,expected_amount_millimes:60900,currency:"TND"});
  assert.equal(f.calls.filter(x=>x[0]==="live").at(-1)[2],45000);
 }finally{f.cleanup();}
});

test("unattributed resume result never confirms",async()=>{
 const f=fixture({resumeResult:{state:"confirmed",gateway_return_correlated:false,fresh_provider_read:true,invoice_state:"settled"}});
 try{
  const q=await f.adapter.quote(invoice),result=await f.adapter.resume(q,requestId,continuation);
  assert.equal(result.state,"effect_unknown");
  assert.equal(result.reasonCode,"payment_effect_unverified");
 }finally{f.cleanup();}
});

test("verified correlated generic rejection stays generic",async()=>{
 const f=fixture({resumeResult:{state:"failed",reason_code:"payment_rejected_reason_unavailable",gateway_return_correlated:true,fresh_provider_read:true,invoice_state:"unpaid"}});
 try{
  const q=await f.adapter.quote(invoice),result=await f.adapter.resume(q,requestId,continuation);
  assert.deepEqual(result,{state:"failed",reasonCode:"payment_rejected_reason_unavailable",rejectionVerified:true});
 }finally{f.cleanup();}
});

test("verified specific bank decline is preserved only when supplied",async()=>{
 const f=fixture({resumeResult:{state:"failed",reason_code:"bank_declined",gateway_return_correlated:true,fresh_provider_read:true,invoice_state:"unpaid"}});
 try{
  const q=await f.adapter.quote(invoice),result=await f.adapter.resume(q,requestId,continuation);
  assert.deepEqual(result,{state:"failed",reasonCode:"bank_declined",rejectionVerified:true});
 }finally{f.cleanup();}
});


test("forensic HTTP exchanges are forwarded only after safe-envelope validation",async()=>{
 const trace=[];
 const req=JSON.stringify({headers:[{name:"cookie",value:{redacted:true,bytes:24}}],body:{kind:"form",fields:[
  {name:"$PAN",value:{redacted:true,bytes:16}},{name:"language",value:"fr"}]}});
 const res=JSON.stringify({headers:[{name:"set-cookie",value:{redacted:true,bytes:30}}],body:{kind:"json",value:{lookup:true}}});
 const exchange={method:"POST",origin:"https://ipay.clictopay.com",path:"/epg/rest/processform.do",
  requestBytes:120,requestSnapshot:req,requestSha256:require("crypto").createHash("sha256").update(req).digest("hex"),requestTruncated:false,
  durationMs:42,responseStatus:200,responseOrigin:"https://ipay.clictopay.com",responsePath:"/epg/rest/processform.do",
  responseBytes:15,responseSnapshot:res,responseSha256:require("crypto").createHash("sha256").update(res).digest("hex"),responseTruncated:false};
 const f=fixture({startEvents:[{event:"http_exchange",exchange}]});
 try{
  const q=await f.adapter.quote(invoice);
  await f.adapter.executeLocal(q,requestId,{bankReturnToken:"A".repeat(43),trace:e=>trace.push(e)});
  assert.equal(trace.length,1);
  assert.equal(trace[0].stage,"http_exchange");
  assert.equal(trace[0].http.method,"POST");
  assert.equal(trace[0].http.responseStatus,200);
  assert.equal(JSON.stringify(trace).includes("4111111111111111"),false);
  assert.equal(JSON.stringify(trace).includes("secret"),false);
 }finally{f.cleanup();}
});

test("live runner events are forwarded as sanitized payment trace",async()=>{
 const trace=[];
 const f=fixture({startEvents:[
  {event:"provider_session_started"},
  {event:"gateway_submission_result",outcome:"redirect",reason_code:"provider_reconciliation_required"},
  {event:"provider_readback",invoice_state:"unpaid",secret:"never"}
 ]});
 try{
  const q=await f.adapter.quote(invoice);
  const result=await f.adapter.executeLocal(q,requestId,{bankReturnToken:"A".repeat(43),trace:e=>trace.push(e)});
  assert.equal(result.state,"requires_bank_action");
  assert.deepEqual(trace,[
   {stage:"provider_session_started"},
   {stage:"gateway_submission_result",outcome:"redirect",reasonCode:"provider_reconciliation_required"},
   {stage:"provider_readback",invoiceState:"unpaid"}
  ]);
  assert.equal(JSON.stringify(trace).includes("never"),false);
 }finally{f.cleanup();}
});
