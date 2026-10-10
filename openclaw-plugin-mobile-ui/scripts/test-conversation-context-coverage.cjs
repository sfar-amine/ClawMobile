const assert=require('node:assert/strict');
(async()=>{
 const client=require('../dist/companion/openclawAgentClient');let reads=0,duplicate=false;
 client.callOpenClawGateway=async()=>{reads++;return {sessions:duplicate?[{key:'duplicated'},{key:'duplicated'}]:Array.from({length:100},(_,n)=>({key:'fixture-'+n}))};};
 const cache=require('../dist/companion/conversationOwnerIndex'),value=await cache.readConversationOwnerRow('outside-shared-window');
 assert.equal(value.row,null);assert.equal(value.notFound,false,'bounded limit100 is not proof of nonexistence');assert.equal(reads,1);
 duplicate=true;cache.invalidateConversationOwner('outside-shared-window');const ambiguous=await cache.readConversationOwnerRow('outside-shared-window');assert.equal(ambiguous.state,'stale');assert.equal(ambiguous.notFound,false,'ambiguous canonical keys cannot prove absence');
 console.log('R18 shared window: missing from full limit100 remains unknown, never a false not_found');
})().catch(error=>{console.error(error);process.exitCode=1});
