const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-config-'));process.env.OPENCLAW_STATE_DIR=root;await fs.mkdir(path.join(root,'clawmobile-companion'));const file=path.join(root,'clawmobile-companion/runs.json');await fs.writeFile(file,JSON.stringify({version:1,runs:[],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));
 let config={agents:{entries:{main:{model:{primary:'openai/old',fallbacks:['local/plain']},thinkingDefault:'low',skills:['retain'],tools:{allow:['read'],deny:['exec']}},other:{model:'other/unchanged'}}},auth:{private:'fixture-configuration-secret'},channels:{untouched:true}},hash='a'.repeat(64),effects=0,uncertain=false;
 const merge=(into,patch)=>{for(const [key,value]of Object.entries(patch)){if(value&&typeof value==='object'&&!Array.isArray(value)){into[key] ||= {};merge(into[key],value);}else into[key]=value;}};
 require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method,params)=>{
  if(method==='config.get')return {config:JSON.parse(JSON.stringify(config)),hash};
  if(method==='models.list')return {models:[{id:'new',provider:'openai',reasoning:true},{id:'plain',provider:'local',reasoning:false}]};
  if(method==='sessions.usage')return {totals:{inputTokens:3,outputTokens:5,totalTokens:8,totalCost:.01}};
  assert.equal(method,'config.patch');assert.equal(params.baseHash,hash);const patch=JSON.parse(params.raw);assert.deepEqual(Object.keys(patch),['agents']);assert.deepEqual(Object.keys(patch.agents.entries),['main']);assert.deepEqual(Object.keys(patch.agents.entries.main).sort(),['model','thinkingDefault']);effects++;merge(config,patch);hash='b'.repeat(64);if(uncertain)throw Error('private-config-diagnostic');return {ok:true};
 };
 const api=require('../dist/companion/agentConfig');const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(method='GET',body,headers={})=>new Promise((resolve,reject)=>{
  const content=body?JSON.stringify(body):null;const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/agent/config',method,headers:{'content-type':'application/json',...(content?{'content-length':Buffer.byteLength(content)}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end(content);
 });
 try{
  const detail=await request();assert.equal(detail.body.model,'openai/old');assert.equal(detail.body.thinking,'low');assert.deepEqual(detail.body.fallbacks,['local/plain']);assert.deepEqual(detail.body.tools.agent.allow,['read']);assert.equal(detail.body.receipt,null);assert.equal(detail.body.usage.totalTokens,8);assert.ok(!JSON.stringify(detail).includes('fixture-configuration-secret'));
  const body={operationId:'set',provider:'openai',model:'new',thinking:'high',revision:hash},owner={'x-clawmobile-owner-flow':'v1'};
  assert.equal((await request('POST',body)).status,403);assert.equal((await request('POST',{...body,raw:'injected'},owner)).status,400);
  const first=await request('POST',body,owner);assert.equal(first.body.state,'completed');assert.equal(effects,1);assert.deepEqual((await request('POST',body,owner)).body,first.body);assert.equal(effects,1);
  assert.equal(config.auth.private,'fixture-configuration-secret');assert.equal(config.agents.entries.other.model,'other/unchanged');assert.deepEqual(config.agents.entries.main.skills,['retain']);assert.deepEqual(config.agents.entries.main.model.fallbacks,['local/plain']);assert.deepEqual(config.agents.entries.main.tools,{allow:['read'],deny:['exec']});
  assert.equal((await request('POST',{...body,thinking:'low'},owner)).status,409);assert.equal(effects,1);
  const stale=await request('POST',{...body,operationId:'stale'},owner);assert.equal(stale.status,409);assert.equal(stale.body.state,'refused');assert.equal(effects,1);
  uncertain=true;const late=await request('POST',{...body,operationId:'late',thinking:'medium',revision:hash},owner);assert.equal(late.body.state,'completed');assert.equal(effects,2);assert.ok(!JSON.stringify(late).includes('private-config-diagnostic'));
  assert.equal((await request('POST',{...body,operationId:'bad-fallback',revision:hash,fallbacks:['unknown/model']},owner)).status,409);assert.equal(effects,2);
  const fallbackChange=await request('POST',{...body,operationId:'fallbacks',revision:hash,fallbacks:[]},owner);assert.equal(fallbackChange.body.state,'completed');assert.deepEqual(config.agents.entries.main.model.fallbacks,[]);assert.equal(effects,3);
  const stored=JSON.parse(await fs.readFile(file,'utf8'));stored.paymentRequests=[{state:'requires_bank_action'}];await fs.writeFile(file,JSON.stringify(stored));const protectedBefore=await fs.readFile(file,'utf8');assert.equal((await request('POST',{...body,operationId:'bank',revision:hash},owner)).status,409);assert.equal(await fs.readFile(file,'utf8'),protectedBefore);assert.equal(effects,3);
  console.log('R6: redacted config/model/usage projection, exact scoped merge-patch, revisions, owner guard, receipts/replay/conflict, late verified setting and bank refusal without write passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
