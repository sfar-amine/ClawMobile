const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'conversation-metadata-'));process.env.OPENCLAW_STATE_DIR=root;
 const file=path.join(root,'clawmobile-companion/runs.json');await fs.mkdir(path.dirname(file));await fs.writeFile(file,JSON.stringify({version:1,runs:[],paymentRequests:[],ownerConfirmations:[],archivedSessionIds:[]}));
 const client=require('../dist/companion/openclawAgentClient');const key=client.expectedCompanionSessionKey('demo');
 let row={key,sessionId:'canonical-session',label:'Original',pinned:false,model:'old',modelProvider:'openai',hasActiveRun:false,permissionModePending:false,private:'private-owner-field'},effects=0,uncertain=false,unknownModel=false;
 client.callOpenClawGateway=async(method,params)=>{
  if(method==='sessions.list'){assert.deepEqual(params,{search:key,limit:20});return {sessions:[{...row}]};}
  if(method==='models.list')return {models:[{id:'new',provider:'openai'},{id:'other',provider:'openai'}]};
  assert.equal(method,'sessions.patch');assert.equal(params.key,key);assert.equal(params.expectedSessionId,'canonical-session');assert.ok(Object.keys(params).every(k=>['key','expectedSessionId','label','pinned','model'].includes(k)));effects++;
  if('label' in params)row.label=params.label;if('pinned' in params)row.pinned=params.pinned;if('model' in params){if(!unknownModel){row.model=params.model.split('/').slice(1).join('/');row.modelProvider=params.model.split('/')[0];}}
  if(uncertain)throw Error('private-dispatch-error');return {ok:true};
 };
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(method='GET',body,headers={},id='demo')=>new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):null;const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/conversations/'+id+'/metadata',method,headers:{'content-type':'application/json',...(data?{'content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end(data)});
 const owner={'x-clawmobile-owner-flow':'v1'};
 try{
  const detail=await request();assert.equal(detail.body.title,'Original');assert.equal(detail.body.pinned,false);assert.equal(detail.body.model,'openai/old');assert.ok(!JSON.stringify(detail).includes('private-owner-field'));
  assert.equal((await request('POST',{operationId:'denied',pinned:true})).status,403);assert.equal((await request('GET',undefined,{Origin:'https://example.invalid'})).status,403);assert.equal((await request('GET',undefined,{},'%')).status,400);
  const body={operationId:'rename',title:'Été à Tunis',pinned:true};const first=await request('POST',body,owner);assert.equal(first.body.state,'completed');assert.equal(row.label,'Été à Tunis');assert.equal(row.pinned,true);assert.equal(effects,1);assert.deepEqual((await request('POST',body,owner)).body,first.body);assert.equal(effects,1);
  assert.equal((await request('POST',{...body,title:'Changed'},owner)).status,409);assert.equal((await request('POST',{operationId:'injection',execAsk:'off'},owner)).status,400);
  assert.equal((await request('POST',{operationId:'unknown-model',model:'unknown/model'},owner)).status,409);assert.equal(effects,1);
  const changed=await request('POST',{operationId:'model',model:'openai/new'},owner);assert.equal(changed.body.state,'completed');assert.equal((await request()).body.model,'openai/new');assert.equal(effects,2);
  row.hasActiveRun=true;assert.equal((await request('POST',{operationId:'active',model:'openai/new'},owner)).status,409);assert.equal(effects,2);row.hasActiveRun=false;
  uncertain=true;const late=await request('POST',{operationId:'late-pin',pinned:false},owner);assert.equal(late.body.state,'completed');assert.equal(effects,3);assert.ok(!JSON.stringify(late).includes('private-dispatch-error'));
  unknownModel=true;const unknown=await request('POST',{operationId:'unknown-effect',model:'openai/other',title:'Will not be observed'},owner);assert.equal(unknown.body.state,'indeterminate');assert.deepEqual((await request('POST',{operationId:'unknown-effect',model:'openai/other',title:'Will not be observed'},owner)).body,unknown.body);assert.equal(effects,4);
  const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.paymentRequests=[{state:'requires_bank_action'}];await fs.writeFile(file,JSON.stringify(saved));const before=await fs.readFile(file,'utf8');const bank=await request('POST',{operationId:'protected-bank',pinned:true},owner);assert.equal(bank.status,409);assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(effects,4);
  console.log('R11 conversation metadata: exact owner identity, rename/pin/model, schema scope, readback after uncertainty, replay/conflict, active-model and bank guards passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
