const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r11-owner-cache-'));process.env.OPENCLAW_STATE_DIR=root;
 const client=require('../dist/companion/openclawAgentClient');let reads=0,fail=false,title='Retained owner title';
 client.callOpenClawGateway=async(method,params)=>{assert.equal(method,'sessions.list');assert.equal(params.search,'companion-');reads++;await new Promise(r=>setTimeout(r,4150));if(fail)throw Error('fixture transient owner outage');return {sessions:['alpha','beta','gamma'].map(id=>({key:client.expectedCompanionSessionKey(id),label:title,pinned:true}))}};
 const runs=require('../dist/companion/runs');
 try{
  for(const id of ['alpha','beta','gamma']){const reserved=await runs.reserveSubmittedRun('fixture '+id,id,'cache-fixture-'+id,{executionSource:'capability_first'});await runs.settleSubmittedRun(reserved.status.runId,'done','Fixture done');}
  const fast=async(options)=>{const start=performance.now(),value=await runs.conversationSummariesPage(options);assert(performance.now()-start<300,'conversation page waited on 4.15s owner');return value;};
  const cold=await fast({limit:1});assert.equal(cold.items[0].title,null);assert.equal(cold.coverage.metadataState,'pending');assert.equal(reads,1);
  await fast({limit:1});assert.equal(reads,1,'cold refresh is single-flight');await new Promise(r=>setTimeout(r,4250));
  const first=await fast({limit:1});assert.equal(first.items[0].title,title);assert.equal(first.items[0].pinned,true);assert.equal(first.items[0].metadataSource,'gateway_sessions_list');assert(first.nextCursor);
  const second=await fast({limit:1,cursor:first.nextCursor});assert.equal(second.dataRevision,first.dataRevision);assert.equal(reads,1,'warm pages use the same owner view');
  fail=true;await new Promise(r=>setTimeout(r,2050));const during=await fast({limit:1,cursor:first.nextCursor});assert.equal(during.dataRevision,first.dataRevision);assert.equal(reads,2);await new Promise(r=>setTimeout(r,4250));
  const after=await fast({limit:1,cursor:first.nextCursor});assert.equal(after.dataRevision,first.dataRevision);assert.equal(after.items[0].title,title);assert.equal(after.items[0].pinned,true);assert.equal(after.items[0].metadataSource,'gateway_sessions_list');assert.equal(after.coverage.metadataState,'stale');
  const cache=require('../dist/companion/conversationOwnerIndex');for(let n=0;n<150;n++)cache.observeConversationOwnerRow({key:'fixture-key-'+n,label:'Fixture',pinned:true});assert(cache.conversationOwnerIndex().rows.size<=100,'individual reads must not grow index indefinitely');
  console.log('R11 cache: 4.15s canonical reads stay off pagination, single-flight/warm cache, failed refresh retains title/pin/source/revision/cursor; synthetic latency only');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
