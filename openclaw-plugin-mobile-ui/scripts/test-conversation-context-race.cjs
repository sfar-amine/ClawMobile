const assert=require('node:assert/strict');
(async()=>{
 const client=require('../dist/companion/openclawAgentClient');let resolve,reads=0,tokens=100,time=100000;const actualNow=Date.now;Date.now=()=>time;
 client.callOpenClawGateway=async()=>{reads++;const captured=tokens;await new Promise(r=>{resolve=r});return {sessions:[{key:'fixture',totalTokens:captured,totalTokensFresh:true,contextTokens:1000,snapshotAt:time}]};};
 const cache=require('../dist/companion/conversationOwnerIndex');
 try{
  const cold=cache.readConversationOwnerRow('fixture');resolve();assert.equal((await cold).row.totalTokens,100);
  time+=2001;cache.conversationOwnerIndex();assert.equal(reads,2);tokens=200;cache.invalidateConversationOwner('fixture');
  const beforeEnd=cache.readConversationOwnerRow('fixture');resolve();const pending=await beforeEnd;
  assert.equal(pending.state,'pending');assert.equal(pending.row.totalTokensFresh,false,'snapshot captured before run end must not qualify the context');assert.equal(reads,2,'no second CLI inside one metadata read');
  const afterEnd=cache.readConversationOwnerRow('fixture');resolve();const fresh=await afterEnd;assert.equal(fresh.state,'observed');assert.equal(fresh.row.totalTokens,200);assert.equal(fresh.row.totalTokensFresh,true);assert.equal(reads,3);
  await cache.readConversationOwnerRow('fixture');assert.equal(reads,3);
  console.log('R18 cache race: old in-flight read after run end is explicitly pending/nonfresh; next shared read restores fresh context without duplicate CLI');
 }finally{Date.now=actualNow;}
})().catch(error=>{console.error(error);process.exitCode=1});
