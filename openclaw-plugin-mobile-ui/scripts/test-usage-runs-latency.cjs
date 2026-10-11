// 11/10 perf task (AGENTS.md: a route above 80 % of its budget in a receipt becomes a task):
// /v1/usage 5.28 s / 6 s and /v1/runs?limit=50 3.82 s / 4 s on the S24. Target: p95 <= 50 % of the acceptance budget.
// Real S24 captures (usage.status, sessions.list, terminal runs registry) and latencies measured on the S24 on 11/10
// (fixtures/s24-2026-10-11/perf-usage-runs-latency.json) are injected around the real HTTP route.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'perf-usage-runs-'));process.env.OPENCLAW_STATE_DIR=root;
const fixtures=path.join(__dirname,'../fixtures');
const capture=file=>JSON.parse(fs.readFileSync(path.join(fixtures,file)));
const measured=capture('s24-2026-10-11/perf-usage-runs-latency.json');assert.equal(measured._capture.sanitized,true);
const latency=measured.response.injectedLatencyMs;
const usageCapture=capture('s24-2026-10-10/gateway/usage.status.json').response;
const sessionsCapture=capture('s24-2026-10-10/gateway/sessions.list.json').response;
const registryCapture=capture('s24-2026-10-10/i1/native-runs-registry.json');assert.equal(registryCapture._capture.sanitized,true);
const acceptance=path.resolve(__dirname,'../../installer/termux-lite/companion-acceptance.py');
const budgets=Object.fromEntries(JSON.parse(cp.execFileSync('python3',['-c',"import ast,json,sys; t=ast.parse(open(sys.argv[1]).read()); print(json.dumps(next(ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='READS' for x in n.targets))))",acceptance],{encoding:'utf8'})));
const target=route=>budgets[route]*1000/2;
assert.equal(budgets['/usage'],6.0,'acceptance budget unchanged');assert.equal(budgets['/runs?limit=50'],4.0,'acceptance budget unchanged');

// Real registry shapes at the retained volume (100 runs): the 12 captured terminal runs, cloned with new ids
// (declared synthetic expansion), plus one Gateway run still running on the captured companion session.
const live=sessionsCapture.sessions.find(s=>String(s.key).includes(':companion-chat-'));assert.ok(live,'captured companion session');
const liveSessionId=String(live.key).split(':companion-chat-')[1];
const base=Date.now()-3600000,runs=[];
for(let i=0;runs.length<99;i++){const row=registryCapture.response.runs[i%registryCapture.response.runs.length];runs.push({...row,runId:row.runId+'-v'+i,clientRunId:undefined,acceptedAt:base-i*60000,updatedAt:base-i*60000+1000});}
const runningId='perf-live-running-run';
const running={runId:runningId,sessionId:liveSessionId,sessionKey:live.key,text:'Requête déclarée du test',userText:'Requête déclarée du test',acceptedAt:Date.now()-20000,updatedAt:Date.now()-20000,state:'running',executionSource:'gateway'};
const registryPath=path.join(root,'clawmobile-companion','runs.json');fs.mkdirSync(path.dirname(registryPath),{recursive:true});
// Written when the runs part starts, relative to the simulated clock (a recent run is not an inactivity candidate).
const writeRegistry=at=>{running.acceptedAt=running.updatedAt=at-20000;runs.forEach((row,i)=>{row.acceptedAt=at-3600000-i*60000;row.updatedAt=row.acceptedAt+1000;});
 fs.writeFileSync(registryPath,JSON.stringify({version:1,runs:[running,...runs],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[],runDeletions:[]}));};

let now=Date.now(),usageFail=false,sessionsFail=false,sessionsLatency=latency['sessions.list.cold'];const unhandled=[];process.on('unhandledRejection',error=>unhandled.push(error));const realNow=Date.now;Date.now=()=>now;
const counts={},timer=ms=>new Promise(r=>setTimeout(r,ms));
require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method,params={},options={})=>{
 counts[method]=(counts[method]||0)+1;
 if(method==='usage.status'){assert.equal(options.hardTimeoutMs,5500);const fail=usageFail;await timer(latency['usage.status']);if(fail)throw Error('fixture usage outage');const value=structuredClone(usageCapture);value.updatedAt=now;return value;}
 if(method==='sessions.list'){assert.ok(options.hardTimeoutMs<=5500,'sessions.list keeps the owner bound');await timer(sessionsLatency);if(sessionsFail)throw Error('fixture sessions.list outage');return structuredClone(sessionsCapture);}
 if(method==='chat.history'){assert.equal(params.sessionKey,live.key);await timer(latency['chat.history']);
  return {messages:[{role:'user',content:[{type:'text',text:running.text}],timestamp:now-15000},{role:'assistant',content:[{type:'text',text:'Résultat déclaré du test'}],timestamp:now-1000,stopReason:'stop'}]};}
 throw Error('unexpected owner '+method);
};
const usage=require('../dist/companion/usage'),{route}=require('../dist/companion/server');
const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}');}));
const get=url=>new Promise((resolve,reject)=>{const began=performance.now();http.get({host:'127.0.0.1',port:server.address().port,path:url,headers:{'user-agent':'okhttp/4.12.0',accept:'application/json'}},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw||'{}'),ms:performance.now()-began}));}).on('error',reject);});
const report={usage:{},runs:{}};
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  // ---- /v1/usage ----
  // Startup prewarm, then the first read arrives as the post-deploy acceptance does (health, control, files first).
  usage.prewarmUsage();await timer(measured.response.acceptanceArrivalMs);
  const first=await get('/v1/usage');report.usage.afterRestart=Math.round(first.ms);
  assert.equal(first.status,200);assert.equal(first.body.providers.find(p=>p.id==='github-copilot').state,'exhausted');
  // Without a last-good view the first read still waits for the CLI (until P0-1's persistent client): it only
  // pays the remainder of the startup read, never a second full one, and stays within the acceptance budget.
  assert.ok(first.ms<=budgets['/usage']*1000,`first /usage after restart ${Math.round(first.ms)} ms over budget`);
  assert.ok(first.ms<=latency['usage.status']-measured.response.acceptanceArrivalMs+250,'the first read joins the startup read');
  assert.equal(counts['usage.status'],1,'the first read joins the startup read');
  const burst=await Promise.all(Array.from({length:10},()=>get('/v1/usage')));assert.ok(burst.every(x=>x.ms<200));assert.equal(counts['usage.status'],1);
  // Every later minute: the held view answers at once, one background read revalidates it.
  const samples=[];
  for(let i=0;i<5;i++){
   now+=61000;const before=counts['usage.status'];const held=await get('/v1/usage');samples.push(held.ms);
   assert.equal(held.body.providers.find(p=>p.id==='github-copilot').state,'exhausted');assert.deepEqual(held.body.issues,[]);
   await Promise.all(Array.from({length:5},()=>get('/v1/usage')));assert.equal(counts['usage.status'],before+1,'single-flight background read');
   await timer(latency['usage.status']+100);
  }
  assert.equal(new Date((await get('/v1/usage')).body.updatedAt).getTime(),now,'the revalidated quotas replace the held view');
  report.usage.afterMinuteMaxMs=Math.round(Math.max(...samples));assert.ok(Math.max(...samples)<=target('/usage'));
  // A failed background read: the held quotas stay, and only the failure sets usage_source_stale.
  usageFail=true;now+=61000;const held=await get('/v1/usage');assert.ok(held.ms<500);assert.deepEqual(held.body.issues,[]);
  await timer(latency['usage.status']+100);const failed=await get('/v1/usage');assert.ok(failed.body.issues.includes('usage_source_stale'));assert.equal(failed.body.providers.find(p=>p.id==='github-copilot').state,'exhausted');
  // Beyond the ten-minute last-good window nothing old is served: the read is awaited and reports unavailability.
  now+=600001;const lost=await get('/v1/usage');assert.ok(lost.ms>=latency['usage.status']-50,'no quota older than ten minutes is served');assert.deepEqual(lost.body.issues,['usage_source_unavailable']);assert.deepEqual(lost.body.providers,[]);
  usageFail=false;

  // ---- /v1/runs?limit=50 ----
  // Cold: sessions.list (SQLite migration, no sessions.json) costs 4.26 s; the list answers within its budget anyway.
  writeRegistry(now);for(const key of Object.keys(counts))delete counts[key];
  const cold=await Promise.all(Array.from({length:5},()=>get('/v1/runs?limit=50')));report.runs.cold=Math.round(Math.max(...cold.map(x=>x.ms)));
  for(const res of cold){assert.equal(res.status,200);assert.equal(res.body.runs.length,50);assert.ok(res.ms<=target('/runs?limit=50'),`cold list ${Math.round(res.ms)} ms`);}
  assert.equal(cold[0].body.runs[0].runId,runningId);assert.equal(cold[0].body.runs[0].state,'running','the stored view while the owner reads continue');
  assert.equal(counts['sessions.list'],1,'one sessions.list for concurrent lists');assert.equal(counts['chat.history']||0,0);
  await timer(latency['sessions.list.cold']+100);
  // Warm index: the transcript read (2.39 s) starts, one per run, and the list still answers within budget.
  const warm=await Promise.all(Array.from({length:5},()=>get('/v1/runs?limit=50')));report.runs.warmWhileTranscript=Math.round(Math.max(...warm.map(x=>x.ms)));
  assert.ok(warm.every(x=>x.ms<=target('/runs?limit=50')));assert.equal(counts['chat.history'],1,'one transcript read in flight per run');assert.equal(counts['sessions.list'],1,'index reused');
  await timer(latency['chat.history']+150);
  // The completed transcript persisted the result: the next poll is a registry read.
  const done=await get('/v1/runs?limit=50');report.runs.afterResult=Math.round(done.ms);
  assert.equal(done.body.runs[0].state,'done');assert.equal(done.body.runs[0].result,'Résultat déclaré du test');assert.ok(done.ms<300);
  assert.equal(JSON.parse(fs.readFileSync(registryPath)).runs.find(r=>r.runId===runningId).result,'Résultat déclaré du test');
  assert.equal(counts['chat.history'],1);
  // A new running run missing from a young index: the held index answers, one background re-read completes it.
  const again=JSON.parse(fs.readFileSync(registryPath));again.runs.unshift({...running,runId:runningId+'-2',sessionId:'perf-new-session',sessionKey:'agent:main:companion-chat-perf-new-session',acceptedAt:now,updatedAt:now});fs.writeFileSync(registryPath,JSON.stringify(again));
  sessionsLatency=latency['sessions.list.warm'];const before=counts['sessions.list'];
  const missing=await get('/v1/runs?limit=50');assert.ok(missing.ms<=target('/runs?limit=50'));assert.equal(counts['sessions.list'],before+1);
  // A failed background index re-read (no request awaits it) keeps the held index and is never an unhandled rejection.
  await timer(latency['sessions.list.warm']+100);const third=JSON.parse(fs.readFileSync(registryPath));third.runs.unshift({...running,runId:runningId+'-3',sessionId:'perf-other-session',sessionKey:'agent:main:companion-chat-perf-other-session',acceptedAt:now,updatedAt:now});fs.writeFileSync(registryPath,JSON.stringify(third));
  sessionsFail=true;const outage=await get('/v1/runs?limit=50');assert.equal(outage.status,200);assert.ok(outage.ms<=target('/runs?limit=50'));
  await timer(latency['sessions.list.warm']+100);sessionsFail=false;assert.deepEqual(unhandled,[],'no unhandled rejection');
  console.log(JSON.stringify({test:'usage-runs-latency',targetMs:{usage:target('/usage'),runs:target('/runs?limit=50')},measuredMs:report,ownerCalls:counts,injected:latency}));
 }finally{Date.now=realNow;server.closeAllConnections();await new Promise(r=>server.close(r));await timer(latency['chat.history']+200);fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
