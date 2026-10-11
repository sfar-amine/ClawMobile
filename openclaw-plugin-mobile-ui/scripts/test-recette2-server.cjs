// Recette 2 (S24 10/10 20:45–20:51 UTC, Companion f95be8d): server causes behind the app's 0/0/4 providers,
// gpt-5.6-sol « off » + session_thinking_defaults_unavailable, and Copilot flipping exhausted → ready.
// Real sanitized captures: fixtures/s24-2026-10-10/ui-recette-2 (this lot) and ui-recette (owner config/catalog/auth).
// Gateway latencies are injected locally; the mock honours each call's own hardTimeoutMs like the CLI does.
const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const read=(dir,name)=>JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10',dir,name+'.json'),'utf8'));
(async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'recette2-'));process.env.OPENCLAW_STATE_DIR=root;
 await fsp.mkdir(path.join(root,'clawmobile-companion'));
 await fsp.writeFile(path.join(root,'clawmobile-companion/runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));
 const config=read('ui-recette','gateway.config.get').response,catalog=read('ui-recette','gateway.models.list').response,auth=read('ui-recette','gateway.models.authStatus').response;
 const companionPage=read('ui-recette','gateway.sessions.list.companion').response,defaultsPage=read('ui-recette-2','gateway.sessions.list.limit1').response;
 const usageStatus=read('ui-recette-2','gateway.usage.status').response,captured=read('ui-recette-2','companion.agent-config');
 // S24 single-call latencies (ui-recette/measures.json, ui-recette-2/measures.json); sessions.list {limit:1} is 2.2 s alone,
 // but 6.2 s here: it lost its old 5.5 s budget among the other parallel CLI reads of /agent/config (captured defect).
 const latency={'config.get':4766,'models.list':2419,'models.authStatus':2608,'sessions.usage':3000,'usage.status':3515,'sessions.list:limit1':6200,'sessions.list:companion-':2210};
 let now=Date.now(),ownerFail=false,usageFail=false;const counts={},budgets={};const realNow=Date.now;Date.now=()=>now;
 const client=require('../dist/companion/openclawAgentClient');
 client.callOpenClawGateway=(method,params={},options={})=>{
  const key=method==='sessions.list'?(params.search==='companion-'?'sessions.list:companion-':'sessions.list:limit1'):method;
  counts[key]=(counts[key]||0)+1;budgets[key]=options.hardTimeoutMs;
  const hard=Math.min((options.timeoutMs||10000)+5000,options.hardTimeoutMs??Infinity);
  return new Promise((resolve,reject)=>{
   const fail=(ownerFail&&['config.get','models.list','models.authStatus'].includes(method))||(usageFail&&method==='usage.status');
   if(latency[key]>hard){setTimeout(()=>reject(Error(`OpenClaw gateway call timed out after ${hard}ms.`)),hard);return;}
   setTimeout(()=>{if(fail)return reject(Error('fixture owner outage'));
    resolve(structuredClone({'config.get':config,'models.list':catalog,'models.authStatus':auth,'sessions.usage':{totals:{totalTokens:51057412,totalCost:1.25}},
     'usage.status':usageStatus,'sessions.list:limit1':defaultsPage,'sessions.list:companion-':{...companionPage,count:companionPage.sessions.length,totalCount:companionPage.sessions.length}}[key]));},latency[key]);
  });
 };
 const {route}=require('../dist/companion/server');const index=require('../dist/companion/conversationOwnerIndex');const owner=require('../dist/companion/modelOwner');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const get=url=>new Promise((resolve,reject)=>{const began=performance.now();http.get({host:'127.0.0.1',port:server.address().port,path:url},res=>{let t='';res.on('data',x=>t+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(t||'{}'),seconds:(performance.now()-began)/1000}));}).on('error',reject);});
 try{
  // 0. The capture really carried the defect.
  assert.deepEqual(captured.response.issues,['session_thinking_defaults_unavailable']);
  assert.deepEqual(captured.response.models.find(m=>m.id==='gpt-5.6-sol').thinkingLevels,['off']);

  // 1. Cold /agent/config: the defaults read gets the owner's 10 s budget (not 5.5 s) and gpt-5.6-sol gets its 8 levels.
  const cold=await get('/v1/agent/config');assert.equal(cold.status,200);
  assert.equal(budgets['sessions.list:limit1'],10000);
  assert.deepEqual(cold.body.issues,[],JSON.stringify(cold.body.issues));
  const sol=cold.body.models.find(m=>m.id==='gpt-5.6-sol');
  assert.deepEqual(sol.thinkingLevels,defaultsPage.defaults.thinkingOptions);assert.equal(sol.thinkingSource,'session_defaults');assert.equal(sol.thinkingDefault,'low');
  assert.ok(cold.seconds<9,'acceptance budget /agent/config 9 s: '+cold.seconds);
  assert.equal(budgets['sessions.usage'],5500,'sessions.usage bounded like the other owner reads');

  // 2. Warm: defaults and sessions.usage are reused (no sessions.list {limit:1}, no sessions.usage); one CLI read fewer per GET.
  const before={...counts};const warm=await get('/v1/agent/config');
  assert.equal(counts['sessions.list:limit1'],before['sessions.list:limit1']);assert.equal(counts['sessions.usage'],before['sessions.usage']);
  assert.deepEqual(warm.body.models.find(m=>m.id==='gpt-5.6-sol').thinkingLevels,sol.thinkingLevels);assert.equal(warm.body.usage.totalTokens,51057412);
  assert.ok(warm.seconds<cold.seconds,'warm '+warm.seconds+' < cold '+cold.seconds);

  // 3. Defaults observed by the conversation owner index (sessions.list search companion-) serve /agent/config too.
  now+=301000;index.conversationOwnerIndex();await new Promise(r=>setTimeout(r,latency['sessions.list:companion-']+50));
  assert.deepEqual(index.peekSessionDefaults(300000).thinkingOptions,defaultsPage.defaults.thinkingOptions);
  const viaIndex={...counts};const third=await get('/v1/agent/config');
  assert.equal(counts['sessions.list:limit1'],viaIndex['sessions.list:limit1'],'no own sessions.list read when the owner index saw the defaults');
  assert.deepEqual(third.body.issues,[]);

  // 4. A defaults read that really fails keeps the last observed defaults (30 min), never « off » for the default model.
  now+=301000;latency['sessions.list:limit1']=12000;
  const kept=await get('/v1/agent/config');assert.deepEqual(kept.body.models.find(m=>m.id==='gpt-5.6-sol').thinkingLevels,sol.thinkingLevels);assert.deepEqual(kept.body.issues,[]);
  now+=1800001;const lost=await get('/v1/agent/config');assert.deepEqual(lost.body.issues,['session_thinking_defaults_unavailable']);latency['sessions.list:limit1']=2210;

  // 5. /providers: one failed background owner refresh no longer turns every provider unknown (the app's 0/0/4).
  now+=1000;await owner.refreshModelOwner();const fresh=await get('/v1/providers');assert.equal(fresh.body.summary.unknown<fresh.body.providers.length,true);
  const readyBefore=fresh.body.summary.ready;assert.ok(readyBefore>=2);
  ownerFail=true;now+=61000;await get('/v1/providers');await new Promise(r=>setTimeout(r,latency['config.get']+100));
  assert.equal(owner.peekModelOwner().stale,true,'the background refresh failed');
  const afterFailure=await get('/v1/providers');
  assert.equal(afterFailure.body.summary.ready,readyBefore,'a successful snapshot younger than 5 min keeps its states after a failed refresh');
  assert.ok(afterFailure.seconds<1.5);
  now+=240000;const expired=await get('/v1/providers');assert.equal(expired.body.summary.ready,0,'older than 5 min: unknown, never a stale « ready »');
  assert.ok(expired.body.providers.every(p=>p.state==='unknown'));
  ownerFail=false;await owner.refreshModelOwner();

  // 6. /usage: a failed usage.status keeps the last real quotas (Copilot stays exhausted), flagged usage_source_stale, retried after 15 s.
  now+=61000;const okUsage=await get('/v1/usage');assert.equal(okUsage.body.providers.find(p=>p.id==='github-copilot').state,'exhausted');
  assert.equal(okUsage.body.providers.find(p=>p.id==='github-copilot').windows[0].resetsAt,null,'the Gateway gives no Copilot reset date');
  usageFail=true;now+=61000;const failed=await get('/v1/usage');
  assert.equal(failed.body.providers.find(p=>p.id==='github-copilot').state,'exhausted');assert.ok(failed.body.issues.includes('usage_source_stale'));
  const providersWhileFailing=await get('/v1/providers');assert.equal(providersWhileFailing.body.providers.find(p=>p.id==='github-copilot').state,'exhausted');
  const calls=counts['usage.status'];now+=10000;await get('/v1/usage');assert.equal(counts['usage.status'],calls,'failure kept 15 s');
  now+=5001;await get('/v1/usage');assert.equal(counts['usage.status'],calls+1,'failure retried after 15 s, not a full minute');
  now+=600001;const gone=await get('/v1/usage');assert.deepEqual(gone.body.providers,[]);assert.deepEqual(gone.body.issues,['usage_source_unavailable']);
  usageFail=false;
  console.log('Recette 2 server (S24 10/10 captures): agent defaults on owner budget and shared with the owner index, bounded/cached sessions.usage, providers keep a <5 min snapshot after a failed refresh, usage keeps last quotas with usage_source_stale passed');
 }finally{Date.now=realNow;server.closeAllConnections();await new Promise(r=>server.close(r));await fsp.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
