// 38 M1 — section Compréhension de Contrôle › Santé, depuis les reçus de runs existants (runs.json).
// Fixture : capture S24 nettoyée du registre de runs (25 runs, 11/10, fixtures/s24-2026-10-11/learning/runs-comprehension-facts.json).
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const capture=require('../fixtures/s24-2026-10-11/learning/runs-comprehension-facts.json');
const now=Date.parse(capture.captured_at);
function storedRun(row){
  const d=row.decision;
  return {runId:row.runId,sessionId:'s1',text:'[nettoyé]',userText:'[nettoyé]',acceptedAt:row.acceptedAt,state:row.state,
    ...(row.executionSource?{executionSource:row.executionSource}:{}),...(row.modality?{modality:row.modality}:{}),
    ...(row.parentClarificationRunId?{parentClarificationRunId:row.parentClarificationRunId}:{}),...(row.clarificationState?{clarificationState:row.clarificationState}:{}),
    ...(d?{decision:{version:2,type:d.type,risk:d.risk,capability:d.capability,confirmationRequired:d.confirmationRequired,
      plan:{...d.plan,...(d.learnedAssociation?{learned_association:'a'.repeat(64)}:{})}}}:{}),...(row.notThis?{notThis:row.notThis}:{})};
}
async function writeRuns(root,rows){await fs.mkdir(path.join(root,'state/clawmobile-companion'),{recursive:true});
  await fs.writeFile(path.join(root,'state/clawmobile-companion/runs.json'),JSON.stringify({version:1,runs:rows.map(storedRun),archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[],runDeletions:[]}));}
function expected(rows,span){const w=rows.filter(r=>r.acceptedAt>=now-span),d=w.filter(r=>r.decision);
  return {runs:w.length,decided:d.length,clarify:d.filter(r=>r.decision.type==='CLARIFY').length,agent:w.filter(r=>!r.decision&&r.executionSource==='gateway').length};}
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'control-comprehension-'));process.env.OPENCLAW_STATE_DIR=path.join(root,'state');
  try{
    await writeRuns(root,capture.runs);
    const {comprehensionRunFacts}=require('../dist/companion/runs');const {projectComprehension,completeHealthSection}=require('../dist/companion/control-health');
    const real=projectComprehension(await comprehensionRunFacts(),now);
    for(const [id,span] of [['24h',86400000],['7d',7*86400000]]){
      const e=expected(capture.runs,span),w=real.windows[id];
      assert.equal(w.runs,e.runs,id);assert.equal(w.decidedRuns,e.decided,id);assert.equal(w.clarify,e.clarify,id);assert.equal(w.agentRuns,e.agent,id);
      assert.equal(w.clarifyRate,e.decided?Math.round(e.clarify/e.decided*1000)/1000:null,id);assert.equal(w.notThis,0);assert.equal(w.learnedDirect,0);assert.equal(w.complete,true);
    }
    // Capture réelle : 9 runs décidés sur 7 jours dont 2 CLARIFY résolues (22 %), aucune correction ni association apprise.
    assert.deepEqual([real.windows['7d'].decidedRuns,real.windows['7d'].clarify,real.windows['7d'].clarificationAnswers],[9,2,2]);
    assert.equal(real.status,'healthy');assert.deepEqual(real.reasons,[]);assert.equal(real.retainedRuns,25);
    assert.ok(!JSON.stringify(real).includes('nettoyé'));
    // Synthétique : run appris direct, « Ce n'est pas ça » sur une transaction, questions > 30 %.
    const synthetic=[...capture.runs,
      {runId:'syn-learned',acceptedAt:now-3600000,state:'done',executionSource:'capability_first',decision:{type:'EXECUTE',risk:'transaction',capability:'payment.owner_native',confirmationRequired:true,plan:{mode:'known',target:'maxit-tunisie',intent:'telecom.orange.topup_own_number'},learnedAssociation:true}},
      {runId:'syn-corrected',acceptedAt:now-1800000,state:'done',executionSource:'capability_first',decision:{type:'EXECUTE',risk:'transaction',capability:'payment.owner_native',confirmationRequired:true,plan:{mode:'known',target:'maxit-tunisie',intent:'telecom.orange.topup_own_number'},learnedAssociation:false},
       notThis:{version:1,operationId:'op-1',at:now-1700000,neutralized:1,counterExample:'recorded',roundSignal:'pending'}},
      ...[1,2,3].map(i=>({runId:'syn-clarify-'+i,acceptedAt:now-i*60000,state:'done',executionSource:'capability_first',decision:{type:'CLARIFY',risk:'transaction',capability:null,confirmationRequired:false,plan:{mode:'needs_clarification',target:'maxit-tunisie',intent:null},learnedAssociation:false}}))];
    await writeRuns(root,synthetic);
    const s=projectComprehension(await comprehensionRunFacts(),now);
    assert.equal(s.windows['24h'].learnedDirect,1);assert.equal(s.windows['24h'].notThis,1);assert.equal(s.windows['24h'].clarify,3);
    assert.equal(s.windows['24h'].learnedDirectRate,Math.round(1/s.windows['24h'].decidedRuns*1000)/1000);
    assert.equal(s.status,'attention');assert.deepEqual(s.reasons,['transaction_corrected','clarify_rate_above_30pct']);
    assert.equal(s.descriptions[0].fr,'Une transaction a été corrigée par « Ce n’est pas ça » cette semaine.');
    assert.deepEqual(projectComprehension(null,now),{status:'unknown',source:'runs',windows:null,reasons:['comprehension_source_unavailable']});
    assert.equal(projectComprehension({facts:[],retainedCap:500},now).status,'unknown');
    // Registre au plafond (500 runs) plus récent que la fenêtre : fenêtre 7 j marquée partielle. Budget de projection.
    const many=Array.from({length:500},(_,i)=>({runId:'v'+i,acceptedAt:now-i*300000,state:'done',executionSource:'capability_first',decision:{type:i%5?'EXECUTE':'CLARIFY',risk:'read',capability:'x',plan:{}}}));
    await writeRuns(root,many);
    const started=performance.now();const volume=projectComprehension(await comprehensionRunFacts(),now);const ms=performance.now()-started;
    assert.equal(volume.windows['7d'].complete,false);assert.equal(volume.windows['24h'].complete,true);assert.ok(ms<200,`projection ${ms}ms`);
    // Route existante /control/health?contract=2 : champ ajouté, révision recalculée, budget 2 s (companion-acceptance.py).
    await writeRuns(root,capture.runs);
    const envelope={schemaVersion:2,sections:{health:{schemaVersion:2,resourceKey:'control/v2/health',dataRevision:'a'.repeat(64),availability:'ready',freshness:'fresh',remainingFreshMs:15000,data:{status:'healthy',fresh:true,components:[]}}}};
    const first=await completeHealthSection(JSON.parse(JSON.stringify(envelope)),path.join(root,'absent.json'),now);
    assert.equal(first.sections.health.data.comprehension.windows['7d'].decidedRuns,9);
    await writeRuns(root,synthetic);
    const second=await completeHealthSection(JSON.parse(JSON.stringify(envelope)),path.join(root,'absent.json'),now);
    assert.notEqual(second.sections.health.dataRevision,first.sections.health.dataRevision);
    await fs.mkdir(path.join(root,'pb/reporting'),{recursive:true});await fs.writeFile(path.join(root,'pb/reporting/__init__.py'),'');
    await fs.writeFile(path.join(root,'pb/reporting/control_snapshot.py'),'print('+JSON.stringify(JSON.stringify(envelope))+')\n');
    const saved={home:process.env.HOME,pb:process.env.SAMANTHA_CONTROL_PLAYBOOKS,cache:process.env.SAMANTHA_CONTROL_CACHE};
    process.env.HOME=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=path.join(root,'pb');delete process.env.SAMANTHA_CONTROL_CACHE;
    const {handleControl}=require('../dist/companion/control');
    const server=http.createServer(async(req,res)=>{if(!await handleControl(req,res,req.url)){res.writeHead(404);res.end();}});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try{
      const t0=performance.now();const body=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:'/control/health?contract=2'},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(d)}));}).on('error',reject));
      const httpMs=performance.now()-t0;assert.equal(body.status,200);
      const c=body.json.sections.health.data.comprehension;assert.equal(c.label.fr,'Compréhension');assert.ok(c.windows['24h']&&c.windows['7d']);assert.ok(httpMs<2000,`http ${httpMs}ms`);
      console.log(JSON.stringify({lot:'38-M1',route:'/control/health?contract=2',field:'sections.health.data.comprehension',httpMs:Math.round(httpMs),projection500Ms:Math.round(ms),real7d:real.windows['7d']}));
    }finally{server.closeAllConnections();await new Promise(r=>server.close(r));Object.assign(process.env,{HOME:saved.home});if(saved.pb)process.env.SAMANTHA_CONTROL_PLAYBOOKS=saved.pb;else delete process.env.SAMANTHA_CONTROL_PLAYBOOKS;if(saved.cache)process.env.SAMANTHA_CONTROL_CACHE=saved.cache;}
    console.log('control-comprehension: real S24 runs capture, 24h/7d rates, attention rules, volume and health route field passed');
  }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
