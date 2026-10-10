const assert=require('node:assert/strict');
(async()=>{
 const client=require('../dist/companion/openclawAgentClient');
 let calls=0,fail=false,unknownAuth=false,time=1000000;
 const realNow=Date.now;Date.now=()=>time;
 client.callOpenClawGateway=async(method)=>{
  calls++;await new Promise(resolve=>setTimeout(resolve,5));
  if(fail)throw Error('fixture unavailable');
  if(method==='config.get')return {hash:'hmac-sha256:fixture',config:{gateway:{token:'fixture-private'},agents:{entries:{main:{model:{primary:'fixture/model',fallbacks:['fixture/backup@profile']},modelPolicy:{allow:['fixture/model']}}}},plugins:{entries:{fixture:{enabled:true,apiKey:'fixture-private'}}}}};
  if(method==='models.list')return {models:[{id:'model',name:'Fixture model',provider:'fixture',contextTokens:16000,contextWindow:32000,input:['text','image','video'],available:true,reasoning:true,thinkingLevels:[{id:'high'}],apiKey:'fixture-private'}]};
  if(method==='models.authStatus')return unknownAuth?{unavailable:true}:{providers:[{provider:'fixture',status:'ok',apiKey:'fixture-private',profiles:[{profileId:'profile',status:'static',credential:'fixture-private'}]}]};
  throw Error('unexpected fixture method');
 };
 const owner=require('../dist/companion/modelOwner');
 try{
  assert.equal(owner.peekModelOwner(),null);
  const results=await Promise.all(Array.from({length:16},()=>owner.readModelOwnerCached()));
  assert.equal(calls,3,'all concurrent readers share exactly one triple owner read');
  assert(results.every(x=>x.state==='fresh'&&x.snapshot));
  const cached=owner.peekModelOwner();assert.equal(cached.config.agents.entries.main.model.fallbacks[0],'fixture/backup@profile');
  assert(!JSON.stringify(cached).includes('fixture-private'),'secret-bearing raw fields are not retained');
  assert.equal(cached.catalog.models[0].name,'Fixture model');assert.equal(cached.catalog.models[0].contextTokens,16000);assert.equal(cached.catalog.models[0].contextWindow,32000);assert.deepEqual(cached.catalog.models[0].input,['text','image','video']);
  cached.auth.providers[0].status='invalid';assert.equal(owner.peekModelOwner().auth.providers[0].status,'ok','peek cannot modify owner cache');
  await owner.readModelOwnerCached();assert.equal(calls,3);
  await owner.readModelOwnerCached({refresh:true});assert.equal(calls,6);
  assert.equal((await owner.readModelOwnerCached({refresh:true})).refreshThrottled,true);assert.equal(calls,6);
  await owner.readModelOwnerFresh();assert.equal(calls,9,'mutation read bypasses completed cache');
  time+=30001;fail=true;const recent=await owner.readModelOwnerCached({refresh:true});assert.equal(recent.state,'stale','known failed auth/config read is stale even inside TTL');assert.equal(calls,12);
  time+=60001;const retained=await owner.readModelOwnerCached();assert.equal(retained.state,'stale');assert.equal(calls,15);assert.equal(retained.snapshot.auth.providers[0].status,'ok');
  await owner.readModelOwnerCached();assert.equal(calls,15,'failed automatic refresh is bounded too');
  time+=60001;fail=false;unknownAuth=true;assert.equal((await owner.readModelOwnerCached()).state,'stale');assert.equal(owner.peekModelOwner().auth.providers[0].status,'ok','unavailable auth never overwrites last valid snapshot');
  time+=60001;unknownAuth=false;assert.equal((await owner.readModelOwnerCached()).state,'fresh');
  console.log('Shared model owner: single-flight, 60s cache, 30s refresh throttle, fresh mutation reads, stale preservation and selective confidential projection; synthetic source only');
 }finally{Date.now=realNow;}
})().catch(error=>{console.error(error);process.exitCode=1});
