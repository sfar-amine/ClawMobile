'use strict';
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {automationRunsQuery,uniqueAutomationJobs,projectCronStatus,projectCronRuns,AutomationRunsPreparation}=require('../dist/companion/automationRunsPreparation');
const row=(i=0)=>({jobId:'fixture-job',action:'finished',ts:10000+i,runAtMs:8000+i,durationMs:2000,status:'ok'});
(async()=>{
 assert.deepEqual(automationRunsQuery('fixture-job',new URLSearchParams()),{id:'fixture-job',limit:20});
 for(const limit of ['0','51','200','01','1.0','-1','NaN',' 20'])assert.throws(()=>automationRunsQuery('fixture-job',new URLSearchParams({limit})),/invalid_automation_runs_query/);
 for(const id of ['../a','a/b','x?token','x'.repeat(161),'','%2f'])assert.throws(()=>automationRunsQuery(id,new URLSearchParams()),/invalid_automation_id/);
 for(const query of ['limit=20&limit=21','limit=20&token=x'])assert.throws(()=>automationRunsQuery('fixture-job',new URLSearchParams(query)),/invalid_automation_runs_query/);
 const jobs=Array.from({length:1000},(_,i)=>({id:'job-'+(i%500)}));assert.equal(uniqueAutomationJobs(jobs).length,500);assert.throws(()=>uniqueAutomationJobs([...jobs,{id:'extra'}]),/scheduler_unavailable/);
 assert.deepEqual(projectCronStatus({enabled:true,jobs:17,nextWakeAtMs:null,storePath:'/private/hidden',sqlitePath:'/private/db'}),{enabled:true,status:'healthy',jobs:17,nextWakeAt:null});
 for(const raw of [null,{}, {enabled:'true',jobs:1,nextWakeAtMs:0},{enabled:true,jobs:1,nextWakeAtMs:Infinity}])assert.throws(()=>projectCronStatus(raw),/scheduler_unavailable/);
 const secret='synthetic-owner@example.test sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
 const page=projectCronRuns({entries:[{...row(),error:secret,summary:secret,sessionKey:secret,provider:secret},{jobId:'fixture-job',action:'finished',ts:11000,status:'future-owner-value'}]},'fixture-job',20);
 assert.equal(page.items[0].startedAt,'1970-01-01T00:00:08.000Z');assert.equal(page.items[1].startedAt,null);assert.equal(page.items[1].durationMs,null);assert.equal(page.items[1].status,'unknown');assert(!JSON.stringify(page).includes(secret));assert.equal(page.items[0].error,'Erreur d’exécution signalée');
 assert.equal(projectCronRuns({entries:Array.from({length:200},(_,i)=>row(i))},'fixture-job',50).items.length,50);
 for(const entries of [[{...row(),jobId:'other'}],[{...row(),action:'started'}],[{...row(),ts:1}],Array.from({length:201},()=>row())])assert.throws(()=>projectCronRuns({entries},'fixture-job',20),/automation_history_unavailable/);
 let calls=0;const captured=require('../fixtures/s24-2026-10-10/gateway/models.list.json');const latency=captured._capture.latencyMs;
 const reader=new AutomationRunsPreparation(async(query,signal)=>{calls++;assert.deepEqual(query,{id:'fixture-job',limit:20});assert.equal(signal.aborted,false);await new Promise(r=>setTimeout(r,latency));return {entries:[row()]};});
 const start=performance.now();const responses=await Promise.all(Array.from({length:20},()=>reader.read('fixture-job',new URLSearchParams())));assert.equal(calls,1);assert(performance.now()-start>=latency-100);assert.equal(reader.stats().active,0);responses[0].items[0].status='mutated';assert.equal((await reader.read('fixture-job',new URLSearchParams())).items[0].status,'ok');assert.equal(calls,1);
 // Inject only the cache monotonic clock; no thirty-second wait or fictional route latency claim.
 const original=Object.getOwnPropertyDescriptor(performance,'now');const realNow=performance.now.bind(performance);let offset=0;Object.defineProperty(performance,'now',{configurable:true,value:()=>realNow()+offset});
 try{offset=20000;await reader.read('fixture-job',new URLSearchParams());assert.equal(calls,1);offset=31000;await reader.read('fixture-job',new URLSearchParams());assert.equal(calls,2);}finally{if(original)Object.defineProperty(performance,'now',original);else delete performance.now;}
 let resolve;let timedCalls=0;const timeoutReader=new AutomationRunsPreparation(async()=>{timedCalls++;return new Promise(r=>resolve=r);},25);await assert.rejects(timeoutReader.read('fixture-job',new URLSearchParams()),/control_budget_exceeded/);assert.equal(timedCalls,1);assert.equal(timeoutReader.stats().active,1);resolve({entries:[row()]});await new Promise(r=>setTimeout(r,10));assert.equal(timeoutReader.stats().active,0);assert.equal(timeoutReader.stats().cacheKeys,0);
 let failedCalls=0;const failed=new AutomationRunsPreparation(async()=>{failedCalls++;throw new Error(secret);});await assert.rejects(failed.read('fixture-job',new URLSearchParams()),e=>e.message==='automation_history_unavailable');assert.equal(failedCalls,1);assert.equal(failed.stats().cacheKeys,0);
 const scoped=new AutomationRunsPreparation(async q=>({entries:[{...row(),jobId:q.id}]}));for(let i=0;i<25;i++)await scoped.read('job-'+i,new URLSearchParams());assert(scoped.stats().cacheKeys<=16);assert(scoped.stats().cacheBytes<=1024*1024);
 console.log('R22 preparation: closed query, canonical public-schema projection, null unknowns, private fields omitted, dedupe1000, shared owner pool30s, realistic captured latency, timeout/no retry; no runtime route or S24 qualification');
})().catch(()=>{console.error('R22_PREPARATION_TEST_FAILED');process.exitCode=1;});
