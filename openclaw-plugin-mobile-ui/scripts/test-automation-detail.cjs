const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'automation-contract-'));
 const old=process.env.OPENCLAW_STATE_DIR;process.env.OPENCLAW_STATE_DIR=root;
 require('../dist/modelFastPath').runModelFastPath=async(text,options)=>{assert.equal(options.checkOnly,true);return {status:'miss',decision:{version:2,type:'REASON',risk:text==='synthetic guarded action'?'transaction':'read'}}};
 const gateway=require('../dist/companion/openclawAgentClient');let jobs=[{id:'one',payload:{kind:'agentTurn',message:'Read scheduler health'},name:'Daily health',description:'Check scheduler',enabled:true,state:{nextRunAtMs:1800000000000}},{id:'bank',payload:{kind:'agentTurn',message:'synthetic guarded action'},name:'Bank confirmation',enabled:true}],effects=0,uncertain=false,listUnavailable=false;
 gateway.callOpenClawGateway=async(method,params)=>{
  if(method==='cron.list'&&listUnavailable)throw Error('private scheduler error');
  if(method==='cron.list')return {jobs:structuredClone(jobs)};
  if(method==='cron.runs')return {entries:Array.from({length:12},(_,i)=>({runAtMs:1800000000000+i,status:'ok',summary:i?'Healthy':'token=never-return'}))};
  if(method==='cron.update'){effects++;const job=jobs.find(x=>x.id===params.id);job.enabled=params.patch.enabled;if(uncertain)throw Error('token=private-dispatch-error');return job;}
  if(method==='cron.run'){effects++;return {ok:true,ran:true};}
  if(method==='cron.remove'){effects++;jobs=jobs.filter(x=>x.id!==params.id);return {ok:true,removed:true};}
  throw Error('unknown method');
 };
 const api=require('../dist/companion/automations'),{route}=require('../dist/companion/server');
 const directory=path.join(root,'clawmobile-companion');await fs.mkdir(directory,{recursive:true});
 const ledger=path.join(directory,'runs.json');await fs.writeFile(ledger,JSON.stringify({version:1,runs:[],paymentRequests:[{id:'payment-fixture',state:'requires_bank_action'}],ownerConfirmations:[{id:'confirmation-fixture',state:'awaiting_owner'}]}));
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const request=(url,method='GET',body,headers={})=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{'content-type':'application/json',...(body?{'content-length':Buffer.byteLength(JSON.stringify(body))}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 try{
  const {automationNotificationProjection}=require('../dist/companion/control');
  const notification=automationNotificationProjection({items:[{id:'scheduled:one',kind:'scheduled',automationId:'one',enabled:jobs[0].enabled,togglable:false},{id:'incidents',kind:'incident',enabled:true,togglable:false}]},jobs);
  assert.equal(notification.items[0].togglable,false);assert.equal(notification.items[0].reason,'action_guard_not_qualified');assert.equal(notification.items[1].togglable,false);
  assert.equal(notification.activationRoute,'/v1/automations/{automationId}/enable|disable');
  const detail=await request('/v1/automations/one');assert.equal(detail.status,200);assert.equal(detail.body.runs.length,10);assert.equal(detail.body.what,'Check scheduler');assert.equal(detail.body.nextRunAt,new Date(1800000000000).toISOString());assert.ok(!JSON.stringify(detail).includes('never-return'));
  assert.equal((await request('/v1/automations/%')).status,400);assert.equal((await request('/v1/automations/missing')).status,404);
  const owner={'x-clawmobile-owner-flow':'v1'};
  assert.equal((await request('/v1/automations/one/disable','POST',{operationId:'deny'})).status,403);
  process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN='1';assert.equal((await request('/v1/automations/one/disable','POST',{operationId:'deny'}, {...owner,Origin:'https://example.invalid'})).status,403);delete process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN;
  assert.equal((await request('/v1/automations/one/disable','POST',{operationId:'bad',command:'ignored'},owner)).status,400);
  const first=await request('/v1/automations/one/disable','POST',{operationId:'disable-one'},owner);assert.equal(first.body.success,true);assert.equal(first.body.state,'completed');assert.equal(effects,1);assert.equal(jobs[0].enabled,false);assert.equal(automationNotificationProjection({items:[{kind:'scheduled',automationId:'one',enabled:jobs[0].enabled}]},jobs).items[0].enabled,false);
  assert.deepEqual((await request('/v1/automations/one/disable','POST',{operationId:'disable-one'},owner)).body,first.body);assert.equal(effects,1);
  assert.equal((await request('/v1/automations/one/enable','POST',{operationId:'disable-one'},owner)).status,409);assert.equal(effects,1);
  const before=await fs.readFile(ledger,'utf8');
  listUnavailable=true;const failed=await api.changeAutomation('one','run',{operationId:'retry-preflight'});assert.equal(failed.state,'failed');assert.equal(failed.error,'scheduler_unavailable');assert.equal(await fs.readFile(ledger,'utf8'),before);
  listUnavailable=false;assert.equal((await api.changeAutomation('one','run',{operationId:'retry-preflight'})).state,'accepted');effects--;
  const afterRetry=await fs.readFile(ledger,'utf8');
  const missing=await request('/v1/automations/later/run','POST',{operationId:'retry-later'},owner);assert.equal(missing.body.state,'not_found');assert.equal(missing.body.error,'automation_not_found');assert.equal(await fs.readFile(ledger,'utf8'),afterRetry);
  jobs.push({id:'later',name:'Reminder',enabled:true,payload:{kind:'agentTurn',message:'Read reminder'}});assert.equal((await api.changeAutomation('later','run',{operationId:'retry-later'})).state,'accepted');effects--;
  for(const word of ['topnet','maxit','clictopay','termux-notification','recharge-carte-mobile','topup-ooredoo','facture-d17']){
   const protectedJob={id:word,name:word,enabled:true,payload:{kind:'agentTurn',message:'Read '+word+' policy'}};jobs.push(protectedJob);
   assert.equal(automationNotificationProjection({items:[{kind:'scheduled',automationId:word}]},jobs).items[0].reason,'action_guard_not_qualified');
   assert.equal((await api.changeAutomation(word,'run',{operationId:'guard-'+word})).state,'accepted');effects--;
  }
  const blocked=await request('/v1/automations/bank/run','POST',{operationId:'bank-guard'},owner);assert.equal(blocked.status,409);assert.equal(blocked.body.state,'blocked');assert.equal(effects,1);
  const parallel=await Promise.all(Array.from({length:5},()=>api.changeAutomation('one','run',{operationId:'run-once'})));assert.equal(effects,2);assert.ok(parallel.some(x=>x.state==='accepted'));assert.ok(parallel.every(x=>['accepted','indeterminate'].includes(x.state)));
  assert.equal((await api.changeAutomation('one','run',{operationId:'run-once'})).state,'accepted');assert.equal(effects,2);
  uncertain=true;const unknown=await api.changeAutomation('one','enable',{operationId:'uncertain'});assert.equal(unknown.state,'indeterminate');assert.equal(effects,3);assert.deepEqual(await api.changeAutomation('one','enable',{operationId:'uncertain'}),unknown);assert.equal(effects,3);assert.ok(!JSON.stringify(unknown).includes('private-dispatch-error'));uncertain=false;
  const removed=await request('/v1/automations/one','DELETE',{operationId:'delete-one'},owner);assert.equal(removed.body.state,'completed',JSON.stringify(removed));assert.equal(effects,4);assert.deepEqual((await request('/v1/automations/one','DELETE',{operationId:'delete-one'},owner)).body,removed.body);assert.equal(effects,4);
  delete require.cache[require.resolve('../dist/companion/automations')];delete require.cache[require.resolve('../dist/companion/nativeOperation')];delete require.cache[require.resolve('../dist/companion/runs')];assert.deepEqual(await require('../dist/companion/automations').changeAutomation('one','delete',{operationId:'delete-one'}),removed.body);assert.equal(effects,4);
  const stored=JSON.parse(await fs.readFile(ledger,'utf8'));assert.deepEqual(stored.paymentRequests,[{id:'payment-fixture',state:'requires_bank_action'}]);assert.deepEqual(stored.ownerConfirmations,[{id:'confirmation-fixture',state:'awaiting_owner'}]);
  console.log('P2-a: native scheduler projection, owner boundary, protected jobs, durable receipts, concurrency, conflict, timeout/no-replay and restart passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.OPENCLAW_STATE_DIR;else process.env.OPENCLAW_STATE_DIR=old;await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
