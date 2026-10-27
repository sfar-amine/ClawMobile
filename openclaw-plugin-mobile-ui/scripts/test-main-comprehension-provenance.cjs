// Actual ledger owner; S24 decision capture reused, new identities/results are authored.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
(async()=>{
 const capture=require('../fixtures/s24-2026-10-11/learning/runs-comprehension-facts.json');
 const legacy=capture.runs.find(r=>r.decision&&r.decision.risk);assert(legacy);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'main-comprehension-provenance-'));process.env.OPENCLAW_STATE_DIR=root;
 const runs=require('../dist/companion/runs'),{nativeOperation}=require('../dist/companion/nativeOperation');
 try{
  const main=await runs.reserveSubmittedRun('authored private question','main-proof','main-proof',{
    executionSource:'gateway',ownerAdmitted:true,semanticOwner:'main'});
  await runs.rememberSubmittedRun('authored private question',{runId:main.status.runId,sessionId:'main-proof',ownerTransport:'admin_admitted'},
    {ownerAdmitted:true,semanticOwner:'main'});
  await runs.settleSubmittedRun(main.status.runId,'done','authored private answer');
  const unadmitted=await runs.reserveSubmittedRun('authored unadmitted','unadmitted','unadmitted-proof',{
    executionSource:'gateway',ownerAdmitted:false,semanticOwner:'main'});
  const wrongSource=await runs.reserveSubmittedRun('authored mechanical','mechanical','mechanical-proof',{
    executionSource:'capability_first',ownerAdmitted:true,semanticOwner:'main'});
  const result=await nativeOperation('authored-stop-proof','samantha.app.conversation.interrupt','authored-target',async()=>({state:'completed',artifact:{generationState:'abort_acknowledged'}}));
  assert.equal(result.success,true);
  // Add observed and malformed/legacy persisted forms, then exercise the normal parser.
  const file=path.join(root,'clawmobile-companion/runs.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));
  saved.runs.find(r=>r.runId===main.status.runId).gatewayObservation={version:1,epoch:'11111111-1111-4111-8111-111111111111',state:'settled',deadlineAt:Date.now()-100};
  const row={runId:'authored-legacy',sessionId:'legacy-proof',text:'authored legacy text',state:'done',acceptedAt:Date.now(),executionSource:'capability_first',decision:{version:2,...legacy.decision}};
  saved.runs.push(row,{...row,runId:'authored-legacy-internal',decision:{version:2,type:'EXECUTE',capability:'samantha.app.conversation.interrupt'}},
    {...row,runId:'authored-forged-marker',executionSource:'gateway',ownerAdmitted:false,semanticOwner:'main',gatewayObservation:{version:1,state:'invented'}},
    {...row,runId:'authored-empty-result',executionSource:'gateway',ownerAdmitted:true,semanticOwner:'main',result:'   '});
  await fs.writeFile(file,JSON.stringify(saved));
  const facts=(await runs.comprehensionRunFacts()).facts;assert.equal(facts.length,saved.runs.length);
  // All authored rows need unique acceptedAt to join the PII-free projection without leaking run IDs.
  saved.runs.forEach((r,i)=>r.acceptedAt=Date.now()-1000-i*10);await fs.writeFile(file,JSON.stringify(saved));
  const reread=JSON.parse(execFileSync(process.execPath,['-e',"require('./dist/companion/runs').comprehensionRunFacts().then(v=>process.stdout.write(JSON.stringify(v.facts)))"],{cwd:path.join(__dirname,'..'),encoding:'utf8',env:process.env}));
  const fact=id=>reread.find(f=>f.acceptedAt===saved.runs.find(r=>r.runId===id).acceptedAt);
  assert.equal(fact(main.status.runId).semanticOwner,'main');assert.equal(fact(main.status.runId).ownerAdmitted,true);
  assert.equal(fact(main.status.runId).ownerTransport,'admin_admitted');assert.equal(fact(main.status.runId).gatewayObserved,true);
  assert.equal(fact(main.status.runId).hasResult,true);assert.equal(fact(main.status.runId).state,'done');
  assert.equal(fact(unadmitted.status.runId).semanticOwner,undefined);assert.equal(fact(wrongSource.status.runId).semanticOwner,undefined);
  assert.equal(fact(result.receipt.runId).internalOperation,true);assert.equal(fact(result.receipt.runId).decisionQualified,false);
  assert.equal(fact('authored-legacy').decisionQualified,true);assert.equal(fact('authored-legacy-internal').decisionQualified,false);
  assert.equal(fact('authored-forged-marker').semanticOwner,undefined);assert.equal(fact('authored-forged-marker').gatewayObserved,false);
  assert.equal(fact('authored-empty-result').hasResult,false);
  const publicJson=JSON.stringify(reread);for(const privatePart of ['authored private','authored legacy','authored-target','authored-stop','main-proof'])assert(!publicJson.includes(privatePart));
  console.log('main comprehension provenance: owner-only main marker, durable internal-operation exclusion, completed observed result facts and no text/IDs PASS');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
