const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'skills-owner-'));process.env.OPENCLAW_WORKSPACE=root;process.env.OPENCLAW_STATE_DIR=root;
 const dir=path.join(root,'skills','demo');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'SKILL.md'),'---\nname: demo\ndescription: Inspect a local document\n---\n## Examples\n- Inspect a document\n- Summarize a local document\n');
 await fs.writeFile(path.join(dir,'execution_feedback.jsonl'),JSON.stringify({outcome:'success',timestamp:1800000000000,tool_results:{batch:{duration_ms:2500}}})+'\n'+JSON.stringify({outcome:'failure',timestamp:1800000001000,duration_ms:1500})+'\ncorrupt');
 await fs.writeFile(path.join(dir,'skill_candidate.json'),JSON.stringify({examples:['Inspect a local document']}));
 let disabled=false,effects=0,uncertain=false,ownerDown=false,trials=0;
 require('../dist/companion/openclawGatewayClient').getGatewayStatus=async()=>({reachable:true});
 require('../dist/companion/intent').submitIntent=async(prompt,session,attachments,options)=>{trials++;assert.ok(prompt.includes('Inspect a local document'));assert.equal(session,'skill-demo');assert.deepEqual(attachments,[]);assert.ok(options.clientRunId.startsWith('skill-trial-'));return {accepted:true,runId:'trial-accepted',sessionId:session};};
 require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method,params,options)=>{
  if(method==='skills.status'){assert.deepEqual(options,{timeoutMs:2500,hardTimeoutMs:3000});if(ownerDown)throw Error('private-owner-error');assert.deepEqual(params,{agentId:'main'});return {skills:[{filePath:path.join(dir,'SKILL.md'),skillKey:'demo-canonical',disabled}]};}
  assert.equal(method,'skills.update');assert.deepEqual(options,{timeoutMs:10000,hardTimeoutMs:12000});assert.equal(params.skillKey,'demo-canonical');assert.deepEqual(Object.keys(params).sort(),['enabled','skillKey']);effects++;disabled=!params.enabled;if(uncertain)throw Error('private-secret');return {ok:true};
 };
 const api=require('../dist/companion/skillControl');const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,method='GET',body,headers={})=>new Promise((resolve,reject)=>{
  const content=body?JSON.stringify(body):null;const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/skills/'+url,method,headers:{'content-type':'application/json',...(content?{'content-length':Buffer.byteLength(content)}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end(content);
 });
 try{
  const detail=await request('demo');assert.equal(detail.status,200);assert.equal(detail.body.trust,'candidate');assert.equal(detail.body.examples.length,3);assert.equal(detail.body.stats.runs,2);assert.equal(detail.body.stats.successRate,.5);assert.equal(detail.body.stats.avgSeconds,2);assert.equal(detail.body.enabled,true);
  const owner={'x-clawmobile-owner-flow':'v1'};assert.equal((await request('demo/disable','POST',{operationId:'deny'})).status,403);assert.equal((await request('%')).status,400);
  const first=await request('demo/disable','POST',{operationId:'disable'},owner);assert.equal(first.body.state,'completed');assert.equal(effects,1);assert.deepEqual((await request('demo/disable','POST',{operationId:'disable'},owner)).body,first.body);assert.equal(effects,1);
  assert.equal((await request('demo/enable','POST',{operationId:'disable'},owner)).status,409);
  assert.equal((await request('demo/try','POST',{operationId:'try-disabled',instruction:'Inspect a local document'},owner)).status,409);assert.equal(trials,0);
  assert.equal((await request('demo')).body.trust,'candidate');assert.equal((await request('demo')).body.tryAvailable,false);
  await fs.unlink(path.join(dir,'skill_candidate.json')); // Separate installed-skill trial fixture, not a runtime promotion.
  const enabled=await request('demo/enable','POST',{operationId:'enable'},owner);assert.equal(enabled.body.state,'completed');
  const trial=await request('demo/try','POST',{operationId:'trial',instruction:'Inspect a local document'},owner);assert.equal(trial.body.state,'accepted');assert.equal(trial.body.artifact.runId,'trial-accepted');assert.equal(trials,1);assert.deepEqual((await request('demo/try','POST',{operationId:'trial',instruction:'Inspect a local document'},owner)).body,trial.body);assert.equal(trials,1);
  assert.equal((await request('demo/try','POST',{operationId:'trial',instruction:'Different instruction'},owner)).status,409);assert.equal(trials,1);
  const reopened=cp.execFileSync(process.execPath,['-e',"require('./dist/companion/skillControl').changeSkill('demo','try',{operationId:'trial',instruction:'Inspect a local document'}).then(x=>process.stdout.write(JSON.stringify(x)))"],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:process.env});assert.deepEqual(JSON.parse(reopened),trial.body);
  const parallel=await Promise.all(Array.from({length:3},()=>request('demo/try','POST',{operationId:'parallel-trial',instruction:'Inspect a local document'},owner)));assert.equal(trials,2);assert.ok(parallel.every(x=>['accepted','indeterminate'].includes(x.body.state)));assert.equal((await request('demo/try','POST',{operationId:'parallel-trial',instruction:'Inspect a local document'},owner)).body.state,'accepted');
  for(const instruction of ['payer avec Maxit','virement 100 EUR','OTP carte bancaire']){assert.equal((await request('demo/try','POST',{operationId:'protected-'+instruction.length,instruction},owner)).status,409);}assert.equal(trials,2);
  const financial=['payer la facture STEG','recharge ooredoo','acheter un ticket','top-up orange','pay electricity bill','régler50TND'];
  const original=await fs.readFile(path.join(dir,'SKILL.md'),'utf8');
  for(const [i,text] of financial.entries()){
   for(const location of ['title','body','fastpath']){
    await fs.writeFile(path.join(dir,'SKILL.md'),location==='title'?original.replace('name: demo','name: '+text):original+(location==='body'?'\n## Procedure\n'+text:'') );
    if(location==='fastpath')await fs.writeFile(path.join(dir,'generalized_skill.json'),JSON.stringify({fast_path:{id:'demo-fast',title:'Inspect',steps:[{description:text}]}}));
    const protectedDetail=await request('demo');assert.equal(protectedDetail.body.activationAvailable,false,text+" "+location);assert.equal(protectedDetail.body.tryAvailable,false);
    const before=effects,priorTrials=trials;
    for(const action of ['enable','disable','try']){const result=await request('demo/'+action,'POST',{operationId:'financial-'+i+'-'+location+'-'+action,...(action==='try'?{instruction:'Inspect a local document'}:{})},owner);assert.equal(result.status,409);assert.equal(result.body.error,'invalid_or_protected_skill');}
    assert.equal(effects,before);assert.equal(trials,priorTrials);
    await fs.rm(path.join(dir,'generalized_skill.json'),{force:true});
   }
   await fs.writeFile(path.join(dir,'SKILL.md'),original);
   assert.equal((await request('demo/try','POST',{operationId:'financial-instruction-'+i,instruction:text},owner)).status,409);
  }
  const begun=performance.now();await request('demo');assert.ok(performance.now()-begun<3500,'GET /skills/id exceeded declared local budget');
  ownerDown=true;const noEffect=await api.changeSkill('demo','disable',{operationId:'retry-before-effect'});assert.equal(noEffect.state,'failed');assert.equal(noEffect.receipt,null);ownerDown=false;assert.equal((await api.changeSkill('demo','disable',{operationId:'retry-before-effect'})).state,'completed');
  uncertain=true;const unknown=await api.changeSkill('demo','enable',{operationId:'unknown'});assert.equal(unknown.state,'indeterminate');assert.deepEqual(await api.changeSkill('demo','enable',{operationId:'unknown'}),unknown);assert.equal(effects,4);assert.ok(!JSON.stringify(unknown).includes('private-secret'));
  console.log('P2-b: source examples/stats, candidate trust, exact canonical skill identity, owner activation and trial, protected/disabled refusal, pre-effect retry, durable replay/conflict and no replay after uncertainty passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
