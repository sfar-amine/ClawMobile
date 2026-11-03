const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'n1-failure-'));process.env.OPENCLAW_STATE_DIR=root;
const reader=require('../dist/companion/receiptPresentation');
const cases=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11c/hs3-presentations-from-captures.json'),'utf8')).cases;
const captured=cases.payment_effect_unknown_fr.presentation;
const orange=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json'),'utf8'));
// Existing real-owner projections are preserved, including unknown financial effect. No payment is executed.
assert.deepEqual(reader.fastPathFailurePresentation({presentation:captured},'execution'),reader.readReceiptPresentation(captured));
let count=1;
for(const reason of ['helper_missing','helper_failed','invalid_result','invalid_check_budget','check_budget_exceeded']) {
 for(const stage of ['resolution','execution']) {
  const p=reader.fastPathFailurePresentation({status:'error',reason,detail:'private provider detail'},stage);
  assert.equal(p.failure.reasonCode,reason);assert.equal(p.failure.stepId,stage);
  assert.equal(p.effect.debited,'unknown');assert.equal(p.failure.notDone.code,'unknown');
  assert(reader.readReceiptPresentation(p));assert(!JSON.stringify(p).includes('private'));count++;
 }
}
for(const raw of [null,[],{status:'error',reason:'constructor'},{status:'error',reason:'Bearer private'},{status:'miss',reason:'helper_missing'}]) {
 const p=reader.fastPathFailurePresentation(raw,'execution');assert.equal(p.failure.reasonCode,undefined);
 assert.equal(p.failure.reason,'La cause n’est pas établie par le reçu.');count++;
}
// ADR 02/11 « le cerveau partout », step 3: the app no longer runs the coordinator before the brain, so no new
// capability-first run is created by submitIntent. Runs already retained (S24 registry) keep their closed failure
// projection: the canonical writer stores it and the receipt API reads it back unchanged.
const runs=require('../dist/companion/runs');
(async()=>{
 const failure=reader.fastPathFailurePresentation({status:'error',reason:'helper_failed',detail:'private provider detail'},'execution');
 const reservation=await runs.reserveSubmittedRun('état de mon forfait Orange','n1-execution','n1-execution-check',{userText:'état de mon forfait Orange',attachments:[],
  requestText:'état de mon forfait Orange',executionSource:'capability_first',decision:orange.decision_envelope,ownerAdmitted:true});
 await runs.settleSubmittedRun(reservation.status.runId,'failed',failure.spoken,{presentation:failure});
 const stored=await runs.getRunStatus(reservation.status.runId);assert.equal(stored.state,'failed');assert.equal(stored.presentation.failure.reasonCode,'helper_failed');
 assert.equal(stored.presentation.effect.debited,'unknown');assert(!JSON.stringify(stored).includes('private'));count++;
 assert.equal(stored.progress.cause,failure.failure.reason);assert.equal(stored.decision.capability,orange.decision_envelope.capability);count++;
 // Synthetic title-boundary vectors in the existing retained registry, not a claimed S24 navigation capture.
 // Use the canonical writer rather than inventing a storage path.
 await runs.rememberSubmittedRun('routed catalogue context',{runId:'n1-title-first',sessionId:'n1-title',acceptedAt:1000,waitedForFinal:false,raw:{}},{userText:'état de mon forfait'});
 await runs.rememberSubmittedRun('Browse Lines',{runId:'n1-title-last',sessionId:'n1-title',acceptedAt:2000,waitedForFinal:false,raw:{}},{userText:'mes soldes'});
 await runs.rememberSubmittedRun('routed context',{runId:'n1-title-literal',sessionId:'n1-literal',acceptedAt:3000,waitedForFinal:false,raw:{}},{userText:'Browse Lines'});
 const titles=await runs.conversationSummariesPage({limit:20});
 assert.equal(titles.items.find(x=>x.sessionId==='n1-title').titlePreview,'état de mon forfait');count++;
 assert.equal(titles.items.find(x=>x.sessionId==='n1-literal').titlePreview,'Browse Lines');count++;
 console.log(JSON.stringify({passed:count,scope:'existing real projections and retained-run failure transport; no live operator or payment execution'}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
