const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'delete-run-contract-'));process.env.OPENCLAW_STATE_DIR=root;
const file=path.join(root,'clawmobile-companion/runs.json');fs.mkdirSync(path.dirname(file),{recursive:true});
const sessions=path.join(root,'agents/main/sessions');fs.mkdirSync(sessions,{recursive:true});fs.writeFileSync(path.join(sessions,'sessions.json'),'[]');
const row=(id,extra={})=>({runId:id,clientRunId:'client-'+id,sessionId:'test-thread',text:'fixture '+id,acceptedAt:Date.now(),state:'done',result:'fixture result',...extra});
const payment=[{id:'payment',draft:{origin:{id:'payment-run'}},state:'requires_bank_action'}];
const confirmation=[{id:'owner',intent:{origin:{id:'owner-run'}},state:'awaiting_owner'}];
fs.writeFileSync(file,JSON.stringify({version:1,runs:[row('one'),row('two'),row('payment-run'),row('owner-run'),row('active',{state:'running',result:undefined})],archivedSessionIds:[],paymentRequests:payment,ownerConfirmations:confirmation}));
const api=require('../dist/companion/runs');const {route}=require('../dist/companion/server');
const request=(port,url,body,headers={})=>new Promise((resolve,reject)=>{
 const encoded=JSON.stringify(body);
 const req=http.request({host:'127.0.0.1',port,path:url,method:'DELETE',headers:{'content-type':'application/json','content-length':Buffer.byteLength(encoded),...headers}},res=>{let text='';res.on('data',v=>text+=v);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)})}catch(error){reject(error)}});});req.on('error',reject);req.end(encoded);
});
(async()=>{
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const port=server.address().port;
  assert.equal((await request(port,'/v1/runs/one',{})).status,400);
  assert.equal((await request(port,'/v1/runs/one',{operationId:'delete-one',extra:true})).status,400);
  process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN='1';
  assert.equal((await request(port,'/v1/runs/one',{operationId:'delete-one'},{Origin:'https://untrusted.invalid'})).status,403);
  delete process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN;
  const first=await request(port,'/v1/runs/one',{operationId:'delete-one'});assert.equal(first.status,200);assert.equal(first.body.state,'completed');assert.equal(first.body.receipt.operationId,'delete-one');
  assert.deepEqual((await request(port,'/v1/runs/one',{operationId:'delete-one'})).body,first.body);
  assert.equal((await request(port,'/v1/runs/two',{operationId:'delete-one'})).status,409);
  const alias=await request(port,'/v1/runs/one',{operationId:'delete-one-again'});assert.equal(alias.body.receipt.operationId,'delete-one-again');
  assert.equal((await request(port,'/v1/runs/payment-run',{operationId:'deny-pay'})).status,409);
  assert.equal((await request(port,'/v1/runs/owner-run',{operationId:'deny-owner'})).status,409);
  assert.equal((await request(port,'/v1/runs/active',{operationId:'deny-active'})).status,409);
  assert.equal((await request(port,'/v1/runs/missing',{operationId:'missing'})).status,404);
  assert.ok(!(await api.listRunSummaries()).some(v=>v.runId==='one'));assert.equal((await api.getRunStatus('one')).state,'unknown');
  await assert.rejects(api.reserveSubmittedRun('new','new-thread','client-one'),e=>e.message==='run_deleted');
  await api.rememberSubmittedRun('late',{runId:'one',sessionId:'test-thread',acceptedAt:Date.now()});
  await api.settleSubmittedRun('one','done','late result');assert.ok(!(await api.listRunSummaries()).some(v=>v.runId==='one'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).paymentRequests,payment);assert.deepEqual(JSON.parse(fs.readFileSync(file)).ownerConfirmations,confirmation);
  delete require.cache[require.resolve('../dist/companion/runs')];
  assert.deepEqual(await require('../dist/companion/runs').deleteRun('one','delete-one'),first.body);
  const concurrent=await Promise.all(Array.from({length:5},()=>api.deleteRun('two','delete-two')));assert.ok(concurrent.every(v=>JSON.stringify(v)===JSON.stringify(concurrent[0])));
  const before=JSON.parse(fs.readFileSync(file));assert.equal(before.runDeletions.filter(v=>v.operationId==='delete-two').length,1);
  // Deleting the last item archives only its empty local history, without touching agent messages.
  const voice='voice-11111111-1111-4111-8111-111111111111';
  await api.saveVoiceTurn('voice-thread',{runId:voice,revision:1,input:'voice',output:'answer',state:'completed'});
  await api.deleteRun(voice,'delete-voice');
  await assert.rejects(api.saveVoiceTurn('voice-thread',{runId:voice,revision:2,input:'voice',output:'late',state:'completed'}),e=>e.message==='run_deleted');
  assert.ok(JSON.parse(fs.readFileSync(file)).archivedSessionIds.includes('voice-thread'));
  const remoteResponse={setHeader(){},end(text){this.body=JSON.parse(text)},statusCode:0};
  await route({method:'DELETE',url:'/v1/runs/active',headers:{},socket:{remoteAddress:'192.0.2.1'}},remoteResponse);assert.equal(remoteResponse.statusCode,403);
  const persisted=JSON.parse(fs.readFileSync(file));
  const fixture=(id,at)=>({version:1,operationId:'op-'+id,runId:id,sessionId:'receipt-thread',action:'delete_run',state:'completed',at});
  const timestamp=Date.now();
  persisted.runDeletions=Array.from({length:1000},(_,i)=>fixture('fifo-'+i,timestamp-100000+i));
  persisted.runs.push(row('capacity-next'),row('capability-pay',{decision:{version:2,capability_id:'payment.owner_native'}}));
  fs.writeFileSync(file,JSON.stringify(persisted));
  const next=await api.deleteRun('capacity-next','capacity-next-op');assert.equal(next.success,true);
  const bounded=JSON.parse(fs.readFileSync(file));assert.equal(bounded.runDeletions.length,1000);
  assert.ok(!bounded.runDeletions.some(x=>x.runId==='fifo-0'));
  assert.ok(bounded.runDeletions.some(x=>x.runId==='fifo-999'));
  assert.deepEqual(await api.deleteRun('capacity-next','capacity-next-op'),next);
  await assert.rejects(api.deleteRun('capability-pay','deny-capability-pay'),e=>e.message==='protected_run');
  bounded.runDeletions.push(fixture('expired',timestamp-31*86400000),{operationId:'malformed',secret:'must-not-log'},null);
  fs.writeFileSync(file,JSON.stringify(bounded));
  const warnings=[];const originalWarn=console.warn;console.warn=(...args)=>warnings.push(args.join(' '));
  try {
    assert.deepEqual(await api.deleteRun('capacity-next','capacity-next-op'),next);
    assert.equal((await api.deleteRun('expired','new-expired-op')).state,'not_found');
    assert.ok(warnings.some(x=>x.includes('invalid_run_deletion_receipts_ignored')));
    assert.ok(!warnings.join('').includes('must-not-log'));
    const registry=JSON.parse(fs.readFileSync(file));
    assert.deepEqual(registry.paymentRequests,payment);assert.deepEqual(registry.ownerConfirmations,confirmation);
  } finally {console.warn=originalWarn;}
  console.log('delete-run: HTTP owner boundary, idempotence, conflict, guards, persistence, concurrency and anti-resurrection passed');
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
