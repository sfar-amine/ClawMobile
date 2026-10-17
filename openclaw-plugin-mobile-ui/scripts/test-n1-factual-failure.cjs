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
const helper=path.join(root,'helper.py'),mode=path.join(root,'mode.json');
// Synthetic fault injection at the existing helper transport (SAM-MIG V2.2: the dialogue protocol of model-fast-path.py); decision is the unchanged real Orange READ fixture.
fs.writeFileSync(helper,`import sys,json\nx=json.load(open(${JSON.stringify(mode)}))\nd=json.loads(${JSON.stringify(JSON.stringify(orange.decision_envelope))})\nm=sys.argv[sys.argv.index('--dialogue')+1]\nprint(json.dumps({'outcome':'READY','handled':True,'goalRef':'goal-0000000000000000a1a1','pendingHandoff':{'goalRef':'goal-0000000000000000a1a1','klass':'FAST'},'decision':d} if x['phase']=='execution' and m=='turn' else {'status':'error','reason':x['reason'],'detail':'private provider detail'}))\n`);
process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
const {submitIntent}=require('../dist/companion/intent'),runs=require('../dist/companion/runs');
(async()=>{
 fs.writeFileSync(mode,JSON.stringify({phase:'resolution',reason:'helper_missing'}));
 const before=await submitIntent('état de mon forfait Orange','n1-resolution',[],{clientRunId:'n1-resolution-check'});
 assert.equal(before.accepted,false);assert.equal(before.submissionState,'not_submitted');assert.equal(before.runId,'');
 assert.equal(before.failure.reasonCode,'helper_missing');assert.equal(before.presentation.failure.stepId,'resolution');count++;
 fs.writeFileSync(mode,JSON.stringify({phase:'execution',reason:'helper_failed'}));
 const after=await submitIntent('état de mon forfait Orange','n1-execution',[],{clientRunId:'n1-execution-check'});
 assert.equal(after.state,'failed');assert.equal(after.failure.reasonCode,'helper_failed');
 assert.equal(after.presentation.effect.debited,'unknown');assert(!after.message.includes('state changed'));assert(!JSON.stringify(after).includes('private'));count++;
 const stored=await runs.getRunStatus(after.runId);assert.equal(stored.presentation.failure.reasonCode,'helper_failed');
 assert.equal(stored.progress.cause,after.failure.reason);assert.equal(stored.decision.capability,orange.decision_envelope.capability);count++;
 // Synthetic title-boundary vectors in the existing retained registry, not a claimed S24 navigation capture.
 // Use the canonical writer rather than inventing a storage path.
 await runs.rememberSubmittedRun('routed catalogue context',{runId:'n1-title-first',sessionId:'n1-title',acceptedAt:1000,waitedForFinal:false,raw:{}},{userText:'état de mon forfait'});
 await runs.rememberSubmittedRun('Browse Lines',{runId:'n1-title-last',sessionId:'n1-title',acceptedAt:2000,waitedForFinal:false,raw:{}},{userText:'mes soldes'});
 await runs.rememberSubmittedRun('routed context',{runId:'n1-title-literal',sessionId:'n1-literal',acceptedAt:3000,waitedForFinal:false,raw:{}},{userText:'Browse Lines'});
 const titles=await runs.conversationSummariesPage({limit:20});
 assert.equal(titles.items.find(x=>x.sessionId==='n1-title').titlePreview,'état de mon forfait');count++;
 assert.equal(titles.items.find(x=>x.sessionId==='n1-literal').titlePreview,'Browse Lines');count++;
 console.log(JSON.stringify({passed:count,scope:'existing real projections and synthetic helper faults; no live operator or payment execution'}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
