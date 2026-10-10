'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),{execFileSync}=require('node:child_process');
const base='../fixtures/s24-2026-10-10/';
const captured=name=>require(base+'r22/'+name+'.json');
const status=captured('cron.status'),history=captured('cron.runs.context-sync'),empty=captured('cron.runs.empty'),unknown=captured('cron.runs.unknown-id');
const jobs=JSON.parse(execFileSync('python3',['-c','import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps([dict(json.loads(j),state=json.loads(s)) for j,s in c.execute("SELECT job_json,state_json FROM cron_jobs ORDER BY sort_order")]))',path.join(__dirname,base,'r5-bis/cron-state.sqlite')],{encoding:'utf8'}));
const client=require('../dist/companion/openclawAgentClient'),counts={};let fail=false;
client.callOpenClawGateway=async(method,params,options)=>{
 counts[method]=(counts[method]||0)+1;
 assert.equal(options.timeoutMs,5000);
 if(method==='cron.list')return {jobs};
 const fixture=method==='cron.status'?status:params.id===empty._capture.params.id?empty:history;
 if(method==='cron.runs'){assert.equal(params.limit,50);if(params.id===unknown._capture.params.id)throw new Error(JSON.stringify(unknown.response));if(fail)throw new Error('private owner@example.invalid');}
 await new Promise(r=>setTimeout(r,fixture._capture.latencyMs));return structuredClone(fixture.response);
};
(async()=>{
 const {route}=require('../dist/companion/server'),{completeAutomationScheduler,schedulerHeader}=require('../dist/companion/automationRunsPreparation');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,headers={},method='GET')=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,headers,method},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(raw||'{}')}));});req.on('error',reject);req.end();});
 try{
  const query='/v1/automations/'+history._capture.params.id+'/runs';const began=performance.now();
  const results=await Promise.all(Array.from({length:20},(_,i)=>request(query+'?limit='+(i%2?20:5))));
  assert.equal(counts['cron.runs'],1);assert(performance.now()-began>=history._capture.latencyMs-50);assert(performance.now()-began<6000);
  assert.equal(results[0].value.items.length,5);assert.equal(results[1].value.items.length,20);
  const row=results[1].value.items[0],real=history.response.entries[0];assert.deepEqual(Object.keys(row),['startedAt','finishedAt','durationMs','status','error']);assert.equal(row.startedAt,new Date(real.runAtMs).toISOString());assert.equal(row.finishedAt,new Date(real.ts).toISOString());assert.equal(row.durationMs,real.durationMs);
  assert(!/summary|diagnostics|sessionId|jobName|owner@example|storePath|sqlitePath/.test(JSON.stringify(results)));
  for(const headers of [{origin:'https://fixture.invalid'},{referer:'https://fixture.invalid'},{'sec-fetch-site':'same-origin'}])assert.equal((await request(query,headers)).status,403);
  for(const q of ['limit=0','limit=51','limit=01','limit=20&limit=21','other=1'])assert.equal((await request(query+'?'+q)).status,400);
  assert.equal((await request(query,{},'POST')).status,403);assert.equal((await request(query,{'x-clawmobile-owner-flow':'v1'},'POST')).status,405);
  assert.deepEqual((await request('/v1/automations/'+empty._capture.params.id+'/runs')).value.items,[]);
  assert.equal((await request('/v1/automations/'+unknown._capture.params.id+'/runs')).status,404);
  fail=true;const failure=await request('/v1/automations/new-fixture/runs');assert.equal(failure.status,503);assert(!JSON.stringify(failure).includes('owner@'));fail=false;
  const make=()=>({schemaVersion:2,sections:{automations:{data:{items:[{id:'one',enabled:true},{id:'one',enabled:true}]},dataRevision:'old'}}});
  const coldStart=performance.now(),cold=completeAutomationScheduler(make());assert(performance.now()-coldStart<100);assert.equal(cold.sections.automations.data.scheduler.status,'unknown');assert.equal(cold.sections.automations.data.items.length,1);
  for(let i=0;i<20;i++)completeAutomationScheduler(make());await new Promise(r=>setTimeout(r,status._capture.latencyMs+100));
  const warm=completeAutomationScheduler(make());assert.equal(warm.sections.automations.data.scheduler.status,'healthy');assert.equal(warm.sections.automations.data.scheduler.jobs,17);assert.equal(counts['cron.status'],1);assert.equal(counts['cron.list'],1);assert.equal(warm.sections.automations.data.scheduler.failedCount,schedulerHeader(status.response,jobs).failedCount);
  assert(!/storePath|sqlitePath/.test(JSON.stringify(warm)));
  console.log('R22 real PR82 cron/SQLite fixtures: HTTP six-second budget, concurrent per-job sharing, field/privacy/owner guards, empty/error, async scheduler header without list delay, one status/list snapshot passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
