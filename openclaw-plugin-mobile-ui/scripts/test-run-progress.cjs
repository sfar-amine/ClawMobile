// HS5 progress.steps[]: real S24 run shapes (fixtures/s24-2026-10-11c/hs5-runs-shapes.json) and
// a Graph presentation computed on a real PaymentRecord capture; HTTP transport on the existing route.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hs5-run-progress-'));process.env.OPENCLAW_STATE_DIR=root;
const {runProgressSteps}=require('../dist/companion/runProgress');
const fixtures=path.join(__dirname,'../fixtures/s24-2026-10-11c');
const shapes=JSON.parse(fs.readFileSync(path.join(fixtures,'hs5-runs-shapes.json'),'utf8')).runs;
const captures=JSON.parse(fs.readFileSync(path.join(fixtures,'hs3-presentations-from-captures.json'),'utf8')).cases;
const T0=1791600000000; // acceptedAt is reduced to its presence in the capture; offsets are real.
const source=r=>({executionSource:r.executionSource||undefined,state:r.state,error:r.error||undefined,acceptedAt:T0,updatedAt:T0+r.updatedAtOffsetMs,
  modality:r.modality||undefined,decision:r.decision||undefined,clarificationState:r.clarificationState||undefined});
const find=pred=>{const r=shapes.find(pred);assert.ok(r);return source(r);};
const ids=p=>p.steps.map(s=>s.id+':'+s.state);

// Capability-first EXECUTE done (Orange balance run of 10/10).
let p=runProgressSteps(find(r=>r.executionSource==='capability_first'&&r.state==='done'&&r.decision?.type==='EXECUTE'));
assert.deepEqual(ids(p),['accepted:done','understood:done','execute:done']);assert.equal(p.steps[2].at,T0+6533);assert.equal(p.failedStep,undefined);
// File 52 E: a real S24 billing receipt, augmented only with the paired Graph
// contract, publishes business stages instead of agent tool calls.
const terminalReceipts=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/hs3-terminal-receipts.json'),'utf8'));
const billingReceipt=terminalReceipts.families.factures.receipt.envelope;
const billingDecision={...billingReceipt,type:'EXECUTE',selected:{...billingReceipt.selected,execution_contract:{
  published_steps:['provider_selection','provider_read','verified_aggregation'],
  published_steps_scope:'business_only_no_agent_tool_calls',
}}};
p=runProgressSteps({executionSource:'capability_first',state:'done',acceptedAt:T0,updatedAt:T0+5510,decision:billingDecision});
assert.deepEqual(ids(p),['accepted:done','understood:done','business-provider_selection:done','business-provider_read:done','business-verified_aggregation:done']);
assert.deepEqual(p.steps.slice(2).map(s=>s.label),['Sélection des fournisseurs','Lecture des factures','Synthèse vérifiée']);
assert.ok(!JSON.stringify(p).includes('claw.skill_route'));
// Unknown or tool-shaped contract entries cannot become public progress labels.
const unsafeDecision={...billingDecision,selected:{...billingDecision.selected,execution_contract:{
  published_steps:['provider_selection','agent.tool_call','{"raw":1}'],
  published_steps_scope:'business_only_no_agent_tool_calls',
}}};
p=runProgressSteps({executionSource:'capability_first',state:'running',acceptedAt:T0,decision:unsafeDecision});
assert.deepEqual(ids(p),['accepted:done','understood:done','business-provider_selection:running']);
const gatewayBusiness=runProgressSteps({executionSource:'gateway',state:'running',acceptedAt:T0,decision:billingDecision,
  events:[{type:'tool',label:'claw.skill_route',at:T0+10,seq:1}]});
assert.deepEqual(ids(gatewayBusiness),['accepted:done','business-provider_selection:running','business-provider_read:pending','business-verified_aggregation:pending']);
assert.ok(!JSON.stringify(gatewayBusiness).includes('claw.skill_route'));
// Failed run: failed step visible, raw error never used as cause, effect unknown.
p=runProgressSteps(find(r=>r.state==='failed'));
assert.deepEqual(ids(p),['accepted:done','understood:done','execute:failed']);assert.equal(p.failedStep,'Exécution');
assert.equal(p.cause,undefined);assert.deepEqual(p.effect,{debited:'unknown',source:'receipt'});assert.ok(!JSON.stringify(p).includes('texte:'));
// Resolved clarification.
assert.deepEqual(ids(runProgressSteps(find(r=>r.decision?.type==='CLARIFY'))),['accepted:done','understood:done','clarify:done']);
// Capability-first run without decision: only what the run proves.
assert.deepEqual(ids(runProgressSteps(find(r=>r.executionSource==='capability_first'&&!r.decision))),['accepted:done','execute:done']);
// Gateway runs: running step visible, done answer.
assert.deepEqual(ids(runProgressSteps(find(r=>r.executionSource==='gateway'&&r.state==='running'))),['accepted:done','answer:running']);
assert.deepEqual(ids(runProgressSteps(find(r=>r.executionSource==='gateway'&&r.state==='done'))),['accepted:done','answer:done']);
const withEvents=runProgressSteps({...find(r=>r.executionSource==='gateway'&&r.state==='running'),events:[{type:'tool',label:'Lecture des factures',at:T0+10,seq:1},{type:'tool',label:'Synthèse',at:T0+20,seq:2},{type:'tool',label:'{"raw":1}',seq:3}]});
assert.deepEqual(ids(withEvents),['accepted:done','event-1:done','event-2:running']);
// Voice runs carry no step list.
assert.equal(runProgressSteps(find(r=>r.modality==='voice')),undefined);
// HS3 presentation from a real PaymentRecord capture: failed step and cause from the receipt.
const failedPayment=captures.payment_effect_unknown_fr.presentation;
p=runProgressSteps({...find(r=>r.state==='failed'),presentation:failedPayment});
assert.equal(p.failedStep,'Exécution du paiement');assert.equal(p.cause,failedPayment.failure.reason);assert.equal(p.steps[1].label,failedPayment.understood.text);
// English presentation switches step labels.
assert.equal(runProgressSteps({...find(r=>r.state==='failed'),presentation:{...failedPayment,locale:'en'}}).steps[0].label,'Request received');

// Existing route GET /v1/runs/{id}: steps derived on read, never persisted.
const helper=path.join(root,'helper.py');fs.writeFileSync(helper,`import sys,json\np=json.loads(${JSON.stringify(JSON.stringify(failedPayment))})\nprint(json.dumps({'status':'eligible'} if '--check' in sys.argv else {'status':'known_error','text':p['spoken'],'presentation':p}))\n`);process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
const {submitIntent}=require('../dist/companion/intent'),{route}=require('../dist/companion/server');
const request=(port,runId)=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:'/v1/runs/'+runId},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(body)})}catch(e){reject(e)}})}).on('error',reject)});
(async()=>{const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 const accepted=await submitIntent('hs5 progress','hs5-session',[],{clientRunId:'hs5-terminal-error'});assert.equal(accepted.state,'failed');
 const timings=[];let response;
 for(let i=0;i<20;i++){const t=performance.now();response=await request(server.address().port,accepted.runId);timings.push(performance.now()-t);}
 assert.equal(response.status,200);const prog=response.body.progress;
 assert.deepEqual(prog.steps.map(s=>s.state),['done','failed']);assert.equal(prog.failedStep,'Exécution du paiement');assert.deepEqual(prog.effect,{debited:'unknown',source:'receipt'});
 timings.sort((a,b)=>a-b);const p95=timings[Math.ceil(timings.length*0.95)-1];assert.ok(p95<1500,'run detail p95 '+p95);
 const stored=JSON.parse(fs.readFileSync(path.join(root,'clawmobile-companion/runs.json'),'utf8'));assert.ok(!JSON.stringify(stored).includes('"steps"'));
 const fresh=cp.spawnSync(process.execPath,['-e',`require(${JSON.stringify(path.resolve(__dirname,'../dist/companion/runs'))}).getRunStatusByClientRunId('hs5-terminal-error').then(s=>{if(!s.progress||!s.progress.steps||s.progress.failedStep!=='Exécution du paiement')process.exit(2);process.stdout.write('ok')})`],{env:{...process.env},encoding:'utf8',timeout:5000});
 assert.equal(fresh.status,0);
 console.log(JSON.stringify({suite:'hs5-run-progress',captureShapes:shapes.length,httpP95Ms:Math.round(p95),persistedSteps:false}));
}finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error('hs5_run_progress_failed',e&&e.message);process.exit(1)});
