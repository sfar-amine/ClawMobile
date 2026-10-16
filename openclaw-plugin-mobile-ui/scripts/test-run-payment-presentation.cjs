// HS3 reliquat : un run qui passe la main à une demande de paiement reflète l'état terminal de cette demande
// (projection à la lecture, sans nouveau store). Entrée : capture S24 réelle du 11/10 (core #176,
// fixtures/s24-2026-10-11/hs3/failed-payment-handoff.json) — runs, paymentRequests et ownerConfirmations existants.
// Le nettoyage a retiré decision.requestId ; la capture établit le lien ownerConfirmations.intent.origin.id →
// runs[].decision.requestId (« Chaînes reconstituées »), que le test remet tel quel.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/hs3/failed-payment-handoff.json'),'utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hs3-payment-run-'));process.env.OPENCLAW_STATE_DIR=root;
const client=require('../dist/companion/openclawAgentClient');client.callOpenClawGateway=()=>{throw Error('live gateway forbidden');};
const {projectRunPayment}=require('../dist/companion/runPaymentPresentation');
const {readReceiptPresentation}=require('../dist/companion/receiptPresentation');
const {runProgressSteps}=require('../dist/companion/runProgress');

const chains=capture.failedPaymentChains;
const linked=chains.filter(c=>c.runLinked);
assert.equal(linked.length,2);assert.ok(linked.every(c=>c.payment.state==='blocked'&&c.run.state==='done'&&c.run.presentation.status==='info'&&c.run.presentation.understood.capability===null));
const T0=Date.parse('2026-10-11T09:00:00Z');
let n=0;
const runOf=(chain,decision)=>({runId:`run-hs3-${++n}`,clientRunId:`client-hs3-${n}`,sessionId:'hs3-payment',text:'<texte>',userText:'<texte>',
  acceptedAt:T0+n*1000,updatedAt:T0+n*1000+500,executionSource:chain.run?.executionSource||'capability_first',state:chain.run?.state||'done',
  result:'<texte>',decision:{...decision,requestId:chain.confirmation?.intent.origin.id||`req-${n}`},presentation:chain.run?.presentation});
const realRuns=linked.map(c=>runOf(c,c.run.decision));
// The other real payment records (chatgpt origin, no run in the capture) are projected through a run whose
// decision is the real payment.owner_native decision of the capture, linked to their own confirmation.
const realDecision=linked[0].run.decision,realPresentation=linked[0].run.presentation;
const unlinked=chains.filter(c=>!c.runLinked&&c.confirmation).map(c=>({...runOf({...c,run:{executionSource:'capability_first',state:'done',presentation:realPresentation}},realDecision)}));
const plain={runId:'run-plain',clientRunId:'client-plain',sessionId:'hs3-other',text:'x',userText:'x',acceptedAt:T0,updatedAt:T0+1,executionSource:'capability_first',state:'done',result:'ok'};
const registry={version:1,runs:[...realRuns,...unlinked,plain],archivedSessionIds:[],
  paymentRequests:chains.map(c=>c.payment),ownerConfirmations:chains.map(c=>c.confirmation).filter(Boolean),runDeletions:[]};
const file=path.join(root,'clawmobile-companion/runs.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(registry));
const before=JSON.stringify(registry.paymentRequests)+JSON.stringify(registry.ownerConfirmations);

// Pure projection on the real linked chain.
const p=projectRunPayment(realRuns[0],registry.paymentRequests,registry.ownerConfirmations);
assert.equal(p.status,'error');assert.equal(p.effect.debited,'unknown');
assert.equal(p.understood.capability,'payment.owner_native');assert.equal(p.meta.capability,'payment.owner_native');
assert.equal(p.understood.label,'Recharger mon numéro');assert.deepEqual(p.understood.slots,{operator:'orange',beneficiary:'owner'});
assert.equal(p.understood.text,'Compris : Recharger mon numéro · Orange · ta ligne');
assert.deepEqual(p.payment,{state:'blocked',reasonCode:'payment_not_submitted',stepId:'execution_error',initialFailure:{stepId:'execution_error',reasonCode:'maxit_order_missing_order_id',at:null}}); // #176 masks timestamps; never invent one.
assert.equal(p.failure.stepId,'execution_error');assert.equal(p.failure.step,'Exécution du paiement');assert.equal(p.failure.reasonCode,'payment_not_submitted');
assert.deepEqual(p.failure.notDone,{code:'payment_not_submitted',text:'Rien n’a été envoyé au fournisseur.'});
// It survives the closed reader used by the intent transport.
assert.deepEqual(readReceiptPresentation(p),p);
// Every real terminal state of the capture.
const byState={};for(const r of unlinked){const x=projectRunPayment(r,registry.paymentRequests,registry.ownerConfirmations);byState[x.payment.state+'|'+x.payment.reasonCode]=x;}
assert.deepEqual(Object.keys(byState).sort(),['effect_unknown|payment_effect_unverified','failed|payment_rejected_reason_unavailable']);
const unknown=byState['effect_unknown|payment_effect_unverified'];assert.equal(unknown.status,'error');assert.equal(unknown.failure.notDone.code,'unknown');assert.equal(unknown.failure.reason,'L’effet du paiement n’est pas vérifié.');
const rejected=byState['failed|payment_rejected_reason_unavailable'];assert.equal(rejected.failure.notDone.code,'unknown');assert.ok(['gateway_submission_started','unknown'].includes(rejected.failure.stepId));
// expired record of the capture (no confirmation): linked by its draft origin when the run created it directly.
const expired=chains.find(c=>c.payment.state==='expired').payment;
const direct=projectRunPayment({runId:'run-direct',decision:realDecision},[{...expired,draft:{adapterId:'maxit.topup',mode:'live',origin:{channel:'samantha',id:'run-direct'}}}],[]);
assert.deepEqual(direct.payment,{state:'expired',reasonCode:'owner_confirmation_expired',stepId:'unknown'});assert.equal(direct.failure.notDone.code,'payment_not_submitted');
// Quote amount (owner record field; masked in the capture) and confirmed state, en locale.
const confirmed=projectRunPayment({...realRuns[0],presentation:{...realPresentation,locale:'en'}},[{...linked[0].payment,state:'confirmed',reasonCode:'gateway_and_provider_confirmed',quote:{payee:'Orange',reference:'R',amountMinor:5000,currency:'TND',decimals:3}}],registry.ownerConfirmations);
assert.equal(confirmed.status,'info');assert.equal(confirmed.failure,undefined);assert.equal(confirmed.understood.slots.amountTnd,'5');assert.equal(confirmed.understood.text,'Understood: Top up my number · Orange · 5 TND · your line');
assert.equal(projectRunPayment(plain,registry.paymentRequests,registry.ownerConfirmations),undefined);
// Steps: the execute step fails with the payment, the run state stays done.
const steps=runProgressSteps({executionSource:'capability_first',state:'done',acceptedAt:T0,updatedAt:T0+5,decision:{type:'EXECUTE'},presentation:p});
assert.deepEqual(steps.steps.map(s=>s.id+':'+s.state),['accepted:done','understood:done','execute:failed']);assert.equal(steps.failedStep,'Exécution du paiement');
assert.equal(steps.steps[1].label,p.understood.text);

(async()=>{
  const runs=require('../dist/companion/runs'),{route}=require('../dist/companion/server');
  const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const get=id=>new Promise((resolve,reject)=>{const t=performance.now();http.get({host:'127.0.0.1',port:server.address().port,path:'/v1/runs/'+id},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),ms:performance.now()-t}));}).on('error',reject);});
  try{
    const times=[];
    for(const run of realRuns){
      const r=await get(run.runId);times.push(r.ms);assert.equal(r.status,200);
      assert.equal(r.body.state,'done'); // run lifecycle unchanged
      assert.equal(r.body.presentation.status,'error');assert.equal(r.body.understood.capability,'payment.owner_native');
      assert.equal(r.body.failure.reasonCode,'payment_not_submitted');assert.equal(r.body.presentation.payment.state,'blocked');
      assert.equal(r.body.progress.steps.find(s=>s.id==='execute').state,'failed');
    }
    assert.ok(Math.max(...times)<1000,`run read ${Math.max(...times)} ms`);
    const listed=await runs.listRunSummaries({limit:20});
    for(const run of realRuns)assert.equal(listed.find(r=>r.runId===run.runId).presentation.status,'error');
    assert.equal(listed.find(r=>r.runId==='run-plain').presentation,undefined);
    // A registry write keeps the projection out of the file and never touches the payment records.
    assert.equal((await runs.deleteRun('run-plain','op-hs3-delete')).state,'completed');
    const after=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.ok(!JSON.stringify(after).includes('paymentPresentation'));
    assert.equal(JSON.stringify(after.paymentRequests)+JSON.stringify(after.ownerConfirmations),before);
    assert.deepEqual(after.runs.find(r=>r.runId===realRuns[0].runId).presentation.understood.capability,null);
    console.log(JSON.stringify({suite:'hs3-run-payment-presentation',s24Capture:true,linkedChains:realRuns.length,states:Object.keys(byState).length+2,maxReadMs:Math.round(Math.max(...times))}));
  }finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
