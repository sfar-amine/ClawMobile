// Capture184 exacte, restaurée dans les champs du propriétaire attestés par _capture ; aucun paiement exécuté.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const file=path.join(__dirname,'../fixtures/s24-2026-10-11/hs3/initial-failure-fast-path.json'),raw=fs.readFileSync(file),capture=JSON.parse(raw);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hs3-initial-'));process.env.OPENCLAW_STATE_DIR=root;
const {projectRunPayment}=require('../dist/companion/runPaymentPresentation'),{readReceiptPresentation}=require('../dist/companion/receiptPresentation');
const chains=capture.blockedChains.filter(c=>c.runLinked);assert.equal(chains.length,3);
const expected=['maxit_topup_command_changed','maxit_order_missing_order_id','gateway_amount_mismatch'];
const toMs=v=>typeof v==='string'?Date.parse(v):v;
const rows=chains.map(c=>{
 // Le nettoyage184 aplatit origin et omet la version de schéma ; restaurer originId capturé, le lien ownerConfirmationId
 // et version:2 du contrat registry existant (test de forme, pas nouveau champ attesté dans la capture184).
 const confirmation={...c.ownerConfirmation,intent:{origin:{id:c.ownerConfirmation.originId}}};
 const payment={...c.payment,ownerConfirmationId:confirmation.id,createdAt:toMs(c.payment.createdAt),updatedAt:toMs(c.payment.endedAt),
  trace:c.payment.trace.map(event=>({...event,at:toMs(event.at)}))};
 const run={...c.run,sessionId:'hs3-capture184',clientRunId:'client-'+c.run.runId,text:'fixture',userText:'fixture',executionSource:'capability_first',
  decision:{version:2,...c.run.decision,requestId:c.run.requestId},acceptedAt:toMs(c.run.acceptedAt),updatedAt:toMs(c.run.updatedAt)};
 return{run,payment,confirmation,c};
});
for(let i=0;i<rows.length;i++){
 const {run,payment,confirmation,c}=rows[i],before=JSON.stringify({run,payment,confirmation}),p=projectRunPayment(run,[payment],[confirmation]);
 assert.equal(p.payment.reasonCode,'payment_not_submitted','état aval séparé');assert.equal(p.payment.initialFailure.reasonCode,expected[i]);
 assert.equal(p.payment.initialFailure.stepId,'execution_error');assert.equal(p.payment.initialFailure.at,payment.trace.find(e=>e.stage==='execution_error').at);
 assert.deepEqual(p.payment.handoff,{runState:'done',runUpdatedAt:run.updatedAt,paymentCreatedAt:payment.createdAt,runUpdatedBeforePaymentCreated:true});
 assert.equal(payment.createdAt-run.updatedAt,c.run.runDoneBeforePaymentCreatedMs);assert.equal(p.effect.debited,'unknown');
 assert.equal(require('../dist/companion/voiceUnderstanding').receiptProvesNoDebit({presentation:p}),false,'initial failure code is not non-debit proof');
 assert.deepEqual(readReceiptPresentation(p),p);assert.equal(JSON.stringify({run,payment,confirmation}),before);
 const later={...payment,trace:[...payment.trace,{stage:'execution_error',at:payment.updatedAt,reasonCode:'browser_context_unavailable'}]};
 assert.equal(projectRunPayment(run,[later],[confirmation]).payment.initialFailure.reasonCode,expected[i],'premier échec, jamais dernier');
 const unknown={...payment,trace:[{stage:'execution_error',at:payment.createdAt,reasonCode:'private_token_x'},...payment.trace]};
 assert.equal(projectRunPayment(run,[unknown],[confirmation]).payment.initialFailure,undefined,'ne pas sauter le premier échec inconnu');
 const precise={...payment,trace:[{stage:'execution_error',at:payment.createdAt,reasonCode:'payment_not_submitted',reasonDetail:expected[i]}]};
 assert.equal(projectRunPayment(run,[precise],[confirmation]).payment.initialFailure.reasonCode,expected[i]);
 const malformed={...payment,trace:Array.from({length:161},()=>payment.trace[3])};assert.equal(projectRunPayment(run,[malformed],[confirmation]).payment.initialFailure,undefined);
 assert.equal(projectRunPayment({...run,state:'running'},[payment],[confirmation]).payment.handoff,undefined);
 const badTime={...run,updatedAt:NaN};assert.equal(projectRunPayment(badTime,[payment],[confirmation]).payment.handoff,undefined);
 const equal=projectRunPayment({...run,updatedAt:payment.createdAt},[payment],[confirmation]);assert.equal(equal.payment.handoff.runUpdatedBeforePaymentCreated,false);
 const laterUpdate=projectRunPayment({...run,updatedAt:payment.createdAt+1000},[payment],[confirmation]);assert.equal(laterUpdate.payment.handoff.runUpdatedBeforePaymentCreated,false);assert.equal('completedBeforePaymentCreated' in laterUpdate.payment.handoff,false,'updatedAt is not completedAt');
 const sanitized=readReceiptPresentation({...p,payment:{...p.payment,initialFailure:{...p.payment.initialFailure,reasonCode:'raw_stack_secret'},handoff:{...p.payment.handoff,runUpdatedBeforePaymentCreated:false}}});
 assert.equal(sanitized.payment.initialFailure,undefined);assert.equal(sanitized.payment.handoff,undefined);assert.equal(sanitized.effect.debited,'unknown');
 assert.equal(JSON.stringify(p).includes('reasonDetail'),false,'aucun payload trace brut');
}
(async()=>{
 const registryFile=path.join(root,'clawmobile-companion/runs.json');fs.mkdirSync(path.dirname(registryFile),{recursive:true});
 const registry={version:1,runs:rows.map(x=>x.run),paymentRequests:rows.map(x=>x.payment),ownerConfirmations:rows.map(x=>x.confirmation),archivedSessionIds:[],runDeletions:[]};fs.writeFileSync(registryFile,JSON.stringify(registry));const before=fs.readFileSync(registryFile,'utf8');
 require('../dist/companion/openclawAgentClient').callOpenClawGateway=()=>{throw Error('live Gateway forbidden');};
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  const get=id=>new Promise((done,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:'/v1/runs/'+id},res=>{let s='';res.on('data',x=>s+=x);res.on('end',()=>done({status:res.statusCode,body:JSON.parse(s)}));}).on('error',reject));
  for(let i=0;i<rows.length;i++){const p=await get(rows[i].run.runId);assert.equal(p.status,200);assert.equal(p.body.state,'done');assert.equal(p.body.presentation.payment.initialFailure.reasonCode,expected[i]);assert.equal(p.body.presentation.payment.handoff.runUpdatedBeforePaymentCreated,true);assert.equal(p.body.presentation.effect.debited,'unknown');}
  assert.equal(fs.readFileSync(registryFile,'utf8'),before,'projection sans mutation du registre/paiement');
  console.log('HS3 capture184: first execution_error, precise sanitized code, done before payment creation, closed reader and immutable HTTP projection passed');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
