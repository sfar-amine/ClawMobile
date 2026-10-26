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
   const guard=require('../dist/capabilityAgentGuard');
   const originalGateway=client.callOpenClawGateway;
   let proofChecks=0,revokeAt=0,sdkRevoked=false;
   client.callOpenClawGateway=async(method,params,options)=>{
    if(method===guard.TYPED_CONTROL_ADMISSION_METHOD){proofChecks++;if(revokeAt===proofChecks)sdkRevoked=true;return guard.typedControlAdmission(params);}
    return originalGateway(method,params,options);
   };
   const previousFlag=process.env.SAMANTHA_BRAIN_ONLY;process.env.SAMANTHA_BRAIN_ONLY='1';
   const sdkRequest=(id,user)=>{
    const args={action:'samantha.app.conversation.interrupt',params:{conversationId:'demo',runId:'run-target'}};
    const sessionKey=client.expectedCompanionSessionKey('demo');
    const context={senderIsOwner:true,agentId:'main',sessionKey,assertInvocationCurrent(){if(sdkRevoked)throw Error('SDK revoked');}};
    assert.equal(guard.agentCapabilityHook({toolName:'samantha_app',params:args,toolCallId:id},
      {requester:{senderIsOwner:true},agentId:'main',runId:user,sessionKey}).block,undefined);
    const bound=guard.consumeTypedInvocation(id,'samantha_app',args,context);
    const operationId='typed-stop-'+crypto.createHash('sha256').update(JSON.stringify([user,'demo','run-target'])).digest('hex');
    const body=JSON.stringify({operationId,runId:'run-target',sdk:{invocationId:id,sessionKey,currentRunId:user}});
    return {body,context,release:guard.holdTypedControlInvocation(bound,args,context,body)};
   };
   try{
    const forged=JSON.stringify({operationId:'forged',runId:'run-target',sdk:{invocationId:'guessed',sessionKey:client.expectedCompanionSessionKey('demo'),currentRunId:'guessed-run'}});
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-clawmobile-owner-flow':'v1'},body:forged})).status,403);assert.equal(sent,3);
    proofChecks=0;const live=sdkRequest('sdk-live','sdk-user-live');
    const tampered=JSON.parse(live.body);tampered.runId='foreign';
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(tampered)})).status,403);assert.equal(sent,3);
    live.context.agentId='contacts';
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:live.body})).status,403);assert.equal(sent,3);
    live.context.agentId='main';
    proofChecks=0;
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:live.body});
    assert.equal(response.status,200);assert.equal((await response.json()).artifact.generationState,'abort_acknowledged');assert(proofChecks>=2);assert.equal(sent,4);
    live.release();assert.throws(()=>guard.typedControlAdmission({invocationId:'sdk-live',operationId:JSON.parse(live.body).operationId,paramsHash:crypto.createHash('sha256').update(live.body).digest('hex')}),/host_admission/);
    for(const nth of [1,2,3]){
     sdkRevoked=false;proofChecks=0;revokeAt=nth;const pending=sdkRequest('sdk-revoked-'+nth,'sdk-user-revoked-'+nth);
     const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:pending.body});
     const result=await response.json();assert.equal(sent,4,'revocation before official abort sends no effect');
     if(nth<3)assert.equal(response.status,403);else assert.equal(result.state,'indeterminate','claimed receipt stays conservative');
     pending.release();sdkRevoked=false;revokeAt=0;
     if(nth===3){
      const retry=sdkRequest('sdk-reread','sdk-user-revoked-'+nth);
      const observed=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:retry.body});
      assert.equal((await observed.json()).state,'indeterminate');assert.equal(sent,4,'uncertain receipt is observed without replay');retry.release();
     }
    }
   }finally{client.callOpenClawGateway=originalGateway;if(previousFlag===undefined)delete process.env.SAMANTHA_BRAIN_ONLY;else process.env.SAMANTHA_BRAIN_ONLY=previousFlag;}
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  // Native WA observations nominate identity only. The current SDK callback,
  // canonical owner config and a fresh positive Gateway identity are all required.
  const Module=require('node:module'),load=Module._load;
  const waKey='agent:main:whatsapp:direct:+19995550123',nativeId='11111111-1111-4111-8111-111111111111',currentId='22222222-2222-4222-8222-222222222222';
  let nativeObserved=true,nativeActive=true,nativeAborts=0,assertions=0;
  await fs.writeFile(path.join(root,'openclaw.json'),JSON.stringify({commands:{ownerAllowFrom:['whatsapp:+19995550123']}}));
  Module._load=function(request,parent,isMain){
   if(request==='../nativeTurnProgress')return {activeObservedNativeWhatsAppRun:async(key,options)=>{
    assert.equal(key,waKey);assert.equal(options.excludeRunId,currentId);
    return nativeObserved?{runId:nativeId,sessionKey:waKey,clockEpoch:'observed-companion-epoch',deadlineAt:Date.now()+60000,state:'running',observationSource:'sdk_message_received'}:null;
   }};
   return load.call(this,request,parent,isMain);
  };
  client.callOpenClawGateway=async(method,params,options)=>{
   assert(options.timeoutMs<=6000);
   if(method==='sessions.list'){assert.equal(params.search,waKey);return {sessions:[{key:waKey,hasActiveRun:true,activeRunIds:nativeActive?[nativeId]:[currentId]}]};}
   assert.equal(method,'chat.abort');assert.deepEqual(params,{sessionKey:waKey,agentId:'main',runId:nativeId,preserveSideRuns:true});
   nativeAborts++;return {ok:true,aborted:true,runIds:[nativeId]};
  };
  const native=require('../dist/companion/capabilityControl');
  const current=()=>{assertions++;},nativeBody={operationId:'native-wa-stop',runId:nativeId};
  try{
   await assert.rejects(()=>native.interruptNativeWhatsAppGeneration(waKey,currentId,nativeBody),/owner_admission_required/);
   await assert.rejects(()=>native.interruptNativeWhatsAppGeneration('agent:contacts:whatsapp:direct:+19995550123',currentId,nativeBody,current),/owner_admission_required/);
   await assert.rejects(()=>native.interruptNativeWhatsAppGeneration(waKey,currentId,nativeBody,()=>{throw Error('SDK revoked')}),/SDK revoked/);
   await assert.rejects(()=>native.interruptNativeWhatsAppGeneration(waKey,currentId,{...nativeBody,runId:currentId},current),/invalid_generation/);
   nativeObserved=false;await assert.rejects(()=>native.interruptNativeWhatsAppGeneration(waKey,currentId,nativeBody,current),/target_not_admitted/);
   nativeObserved=true;nativeActive=false;await assert.rejects(()=>native.interruptNativeWhatsAppGeneration(waKey,currentId,nativeBody,current),/target_not_admitted/);
   assert.equal(nativeAborts,0);nativeActive=true;
   const receipt=await native.interruptNativeWhatsAppGeneration(waKey,currentId,nativeBody,current);
   assert.equal(receipt.artifact.effects,'not_undone');assert.equal(nativeAborts,1);assert(assertions>=5);
   nativeObserved=false;nativeActive=false;
   assert.deepEqual(await native.interruptNativeWhatsAppGeneration(waKey,currentId,nativeBody,current),receipt);assert.equal(nativeAborts,1);
  }finally{Module._load=load;}
  console.log('generation-interrupt: PASS (exact native owner/session/run, canonical abort, receipt replay/uncertainty, bank guard, P1 HTTP and native WA SDK admission)');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
