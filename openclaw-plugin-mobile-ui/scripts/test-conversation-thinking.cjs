const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r18-thinking-'));process.env.OPENCLAW_STATE_DIR=root;
 const client=require('../dist/companion/openclawAgentClient'),key=client.expectedCompanionSessionKey('alpha');
 let reads=0,effects=0,slow=true,uncertain=false,lostEffect=false;
 const row={key,sessionId:'fixture-identity',model:'fixture',modelProvider:'openai',hasActiveRun:false,permissionModePending:false,
  thinkingLevels:['off','low','high','max','ultra'].map(id=>({id,label:id})),thinkingDefault:'low',totalTokens:4000,contextTokens:16000,totalTokensFresh:true,snapshotAt:1800000000000};
 client.callOpenClawGateway=async(method,params)=>{
  if(method==='sessions.list'){reads++;if(slow)await new Promise(r=>setTimeout(r,4150));return {sessions:[{...row}]};}
  assert.equal(method,'sessions.patch','metadata must never initiate a model/config fan-out');
  assert.equal(params.key,key);assert.equal(params.expectedSessionId,row.sessionId);
  assert.deepEqual(Object.keys(params).sort(),['expectedSessionId','key','thinkingLevel']);effects++;
  if(!lostEffect)row.thinkingLevel=params.thinkingLevel;
  if(uncertain)throw Object.assign(Error('fixture deadline'),{code:'ETIMEDOUT'});
  return {ok:true,entry:{...row}};
 };
 const {route}=require('../dist/companion/server');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(body,owner=true)=>new Promise((resolve,reject)=>{
  const data=body?JSON.stringify(body):null,start=performance.now();
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/conversations/alpha/metadata',method:body?'POST':'GET',headers:{'content-type':'application/json',...(owner?{'x-clawmobile-owner-flow':'v1'}:{}),...(data?{'content-length':Buffer.byteLength(data)}:{})}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),ms:performance.now()-start}));});req.on('error',reject);req.end(data);
 });
 try{
  const [cold,concurrent]=await Promise.all([request(),request()]);assert.equal(cold.status,200);assert(cold.ms<6000);assert.equal(reads,1);assert.equal(concurrent.status,200);
  assert.equal(cold.body.hasActiveRun,false);assert.equal(cold.body.thinkingChangeAvailable,true);assert.equal(cold.body.thinkingLevel,'low');assert.equal(cold.body.thinkingLevelSource,'default');assert.deepEqual(cold.body.thinkingLevels,['off','low','high','max','ultra']);assert.equal(cold.body.context.percent,25);assert(cold.body.issues.includes('conversation_model_catalog_unavailable'));
  const warm=await request();assert(warm.ms<1500);assert.equal(reads,1);
  slow=false;
  const before=reads;
  for(const level of ['bogus','adaptive']){const result=await request({operationId:'unsupported-'+level,thinkingLevel:level});assert.equal(result.status,400);assert.equal(result.body.error,'unsupported_thinking_level');}
  assert.equal(effects,0);assert.equal(reads,before+2,'unsupported choices are checked against canonical session options');
  assert.equal((await request({operationId:'without-owner',thinkingLevel:'high'},false)).status,403);assert.equal(effects,0);
  row.hasActiveRun=true;const busy=await request({operationId:'busy',thinkingLevel:'high'});assert.equal(busy.status,409);assert.equal(busy.body.error,'run_active');row.hasActiveRun=false;
  const choice={operationId:'selected',thinkingLevel:'high'},changed=await request(choice);assert.equal(changed.body.state,'completed');assert.equal(effects,1);
  assert.deepEqual((await request(choice)).body,changed.body);assert.equal(effects,1);assert.equal((await request({...choice,thinkingLevel:'low'})).status,409);
  const selected=await request();assert.equal(selected.body.thinkingLevel,'high');assert.equal(selected.body.thinkingLevelSource,'session');
  const runs=require('../dist/companion/runs');
  const run=await runs.reserveSubmittedRun('fixture turn','alpha','r18-fixture',{executionSource:'gateway'});await runs.settleSubmittedRun(run.status.runId,'done','fixture complete');
  row.totalTokens=8000;slow=true;const prior=reads;const ended=await Promise.all([request(),request()]);assert.equal(reads,prior+1);assert.equal(ended[0].body.context.percent,50);assert(ended[0].ms<6000);const after=await request();assert(after.ms<1500);assert.equal(reads,prior+1);slow=false;
  uncertain=true;const late=await request({operationId:'late',thinkingLevel:'low'});assert.equal(late.body.state,'completed');assert.equal(effects,2);
  lostEffect=true;const unresolvedBody={operationId:'uncertain',thinkingLevel:'high'},unresolved=await request(unresolvedBody);assert.equal(unresolved.body.state,'indeterminate');assert.deepEqual((await request(unresolvedBody)).body,unresolved.body);assert.equal(effects,3);uncertain=false;lostEffect=false;
  const file=path.join(root,'clawmobile-companion/runs.json'),registry=JSON.parse(await fs.readFile(file,'utf8'));registry.paymentRequests=[{state:'requires_bank_action'}];await fs.writeFile(file,JSON.stringify(registry));
  const beforeBank=await fs.readFile(file,'utf8');assert.equal((await request({operationId:'bank',thinkingLevel:'high'})).status,409);assert.equal(await fs.readFile(file,'utf8'),beforeBank);assert.equal(effects,3);
  registry.paymentRequests=[];registry.ownerConfirmations=[{state:'awaiting_owner',expiresAt:Date.now()+60000}];await fs.writeFile(file,JSON.stringify(registry));const beforeConfirmation=await fs.readFile(file,'utf8');assert.equal((await request({operationId:'protected-confirmation',thinkingLevel:'high'})).status,409);assert.equal(await fs.readFile(file,'utf8'),beforeConfirmation);assert.equal(effects,3);
  delete row.thinkingLevel;delete row.thinkingDefault;delete row.thinkingLevels;row.totalTokensFresh=false;require('../dist/companion/conversationOwnerIndex').invalidateConversationOwner(key);const missing=await request();assert.equal(missing.body.thinkingLevel,null);assert.equal(missing.body.thinkingLevelSource,null);assert.deepEqual(missing.body.thinkingLevels,[]);assert.equal(missing.body.thinkingChangeAvailable,false);assert.equal(missing.body.context,null);
  console.log('R18 synthetic public2026.9.6: cold/warm shared read budgets, dynamic canonical levels/default/session, missing catalogue, owner/run/bank guards, exact patch, replay/conflict, verified late result and no uncertain redispatch');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
