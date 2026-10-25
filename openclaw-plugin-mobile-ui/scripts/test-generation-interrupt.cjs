const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'generation-interrupt-'));process.env.OPENCLAW_STATE_DIR=root;
 const directory=path.join(root,'clawmobile-companion'),file=path.join(directory,'runs.json');await fs.mkdir(directory);
 const target={runId:'run-target',sessionId:'demo',text:'authored-read-only-request',userText:'Question de recette',requestText:'Question de recette',
   state:'running',acceptedAt:Date.now()-1000,updatedAt:Date.now(),executionSource:'gateway',ownerAdmitted:true,ownerTransport:'admin_admitted'};
 await fs.writeFile(file,JSON.stringify({version:1,runs:[target,{...target,runId:'foreign',sessionId:'other'},
   {...target,runId:'nonowner',ownerAdmitted:false}],paymentRequests:[],ownerConfirmations:[],archivedSessionIds:[]}));
 const client=require('../dist/companion/openclawAgentClient'),runs=require('../dist/companion/runs');
 let following=true;
 runs.activeObservedGatewayRun=async(runId,key)=>following&&['run-target','foreign','nonowner'].includes(runId)&&key===client.expectedCompanionSessionKey('demo');
 let sent=0,uncertain=false;
 client.callOpenClawGateway=async(method,params,options)=>{
   assert.equal(method,'chat.abort');assert.deepEqual(params,{sessionKey:client.expectedCompanionSessionKey('demo'),agentId:'main',runId:'run-target',preserveSideRuns:true});
   assert(options.timeoutMs<=5500);sent++;
   if(uncertain)throw Error('private Gateway diagnostics');
   return {ok:true,aborted:true,runIds:['run-target']};
 };
 runs.getRunStatus=async runId=>({runId,state:'failed',replayEffect:'unknown'});
 const {interruptConversationGeneration,activeConversationGenerations}=require('../dist/companion/capabilityControl');
 try{
  assert.deepEqual((await activeConversationGenerations('demo')).items.map(row=>row.runId),['run-target']);
  await assert.rejects(()=>interruptConversationGeneration('demo',{operationId:'foreign',runId:'foreign'},()=>{}),/target_not_admitted/);
  await assert.rejects(()=>interruptConversationGeneration('demo',{operationId:'nonowner',runId:'nonowner'},()=>{}),/target_not_admitted/);
  assert.equal(sent,0);
  following=false;
  await assert.rejects(()=>interruptConversationGeneration('demo',{operationId:'event-gap',runId:'run-target'},()=>{}),/target_not_admitted/);
  following=true;assert.equal(sent,0);
  await assert.rejects(()=>interruptConversationGeneration('demo',{operationId:'no-proof',runId:'run-target'}),/owner_admission_required/);
  assert.equal(sent,0);
  const body={operationId:'stop-1',runId:'run-target'};
  const first=await interruptConversationGeneration('demo',body,()=>{});
  assert.equal(first.artifact.generationState,'abort_acknowledged');assert.equal(first.artifact.effects,'not_undone');
  assert.equal(first.artifact.effectVerification,'verify_existing_receipts');assert.equal(first.receipt.action,'samantha.app.conversation.interrupt');
  assert.equal(sent,1);assert.deepEqual(await interruptConversationGeneration('demo',body,()=>{}),first);assert.equal(sent,1);
  uncertain=true;
  const unknown=await interruptConversationGeneration('demo',{operationId:'stop-unknown',runId:'run-target'},()=>{});
  assert.equal(unknown.state,'indeterminate');assert(!JSON.stringify(unknown).includes('private Gateway diagnostics'));
  assert.deepEqual(await interruptConversationGeneration('demo',{operationId:'stop-unknown',runId:'run-target'},()=>{}),unknown);assert.equal(sent,2);
  await assert.rejects(()=>interruptConversationGeneration('demo',{operationId:'expired',runId:'run-target'},()=>{throw Error('expired')}));assert.equal(sent,2);
  const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.paymentRequests=[{state:'effect_unknown'}];await fs.writeFile(file,JSON.stringify(saved));
  await assert.rejects(()=>interruptConversationGeneration('demo',{operationId:'bank',runId:'run-target'},()=>{}),/protected_owner_activity/);assert.equal(sent,2);
  const {route}=require('../dist/companion/server');
  const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const url='http://127.0.0.1:'+server.address().port+'/v1/conversations/demo/interrupt';
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-clawmobile-owner-flow':'v1'},body:JSON.stringify(body)});
   assert.equal(response.status,403);assert.equal(sent,2);
   // A synthetic already-enrolled key exercises the real P1 signature verifier.
   // The enrollment/biometric workflow has its own unchanged adversarial suite.
   const {admissionMessage,sha256Hex}=require('../dist/companion/ownerTurnAdmission');
   const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),der=keys.publicKey.export({type:'spki',format:'der'}),keyId=sha256Hex(der);
   await fs.writeFile(path.join(directory,'owner-turn-admission.json'),JSON.stringify({version:1,keyId,publicKey:der.toString('base64'),
     enrolledAt:Date.now(),confirmationId:crypto.randomUUID(),epoch:crypto.randomBytes(16).toString('hex')}),{mode:0o600});
   const signed=(body,timestamp=Date.now())=>{
    const nonce=crypto.randomBytes(16).toString('hex'),message=admissionMessage({method:'POST',path:'/v1/conversations/demo/interrupt',
      bodyHash:sha256Hex(Buffer.from(body)),clientRunId:JSON.parse(body).operationId,sessionId:'demo',timestamp:String(timestamp),nonce,keyId});
    return {'content-type':'application/json','x-samantha-admission':'v1','x-samantha-admission-key':keyId,
      'x-samantha-admission-ts':String(timestamp),'x-samantha-admission-nonce':nonce,
      'x-samantha-admission-signature':crypto.sign('sha256',Buffer.from(message),keys.privateKey).toString('base64')};
   };
   saved.paymentRequests=[];await fs.writeFile(file,JSON.stringify(saved));uncertain=false;
   const encoded=JSON.stringify({operationId:'http-stop-1',runId:'run-target'}),headers=signed(encoded);
   const ok=await fetch(url,{method:'POST',headers,body:encoded});assert.equal(ok.status,200);const receipt=await ok.json();
   assert.equal(receipt.artifact.generationState,'abort_acknowledged');assert.equal(sent,3);
   assert.equal((await fetch(url,{method:'POST',headers,body:encoded})).status,403,'replayed admission nonce is refused');assert.equal(sent,3);
   const reread=await fetch(url,{method:'POST',headers:signed(encoded),body:encoded});assert.equal(reread.status,200);assert.deepEqual(await reread.json(),receipt);assert.equal(sent,3);
   const stale=JSON.stringify({operationId:'http-stop-stale',runId:'run-target'});
   assert.equal((await fetch(url,{method:'POST',headers:signed(stale,Date.now()-60000),body:stale})).status,403);assert.equal(sent,3);
   const other=JSON.stringify({operationId:'http-stop-foreign',runId:'foreign'});
   assert.equal((await fetch(url,{method:'POST',headers:signed(other),body:other})).status,403);assert.equal(sent,3);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  console.log('generation-interrupt: PASS (exact native owner/session/run, canonical abort, receipt replay/uncertainty, bank guard, HTTP admission)');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
