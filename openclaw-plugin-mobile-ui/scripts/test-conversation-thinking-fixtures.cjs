const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
(async()=>{
 const fixture=require('../fixtures/s24-2026-10-10/gateway/sessions.list.json');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r18-installed-fixture-'));process.env.OPENCLAW_STATE_DIR=root;
 const client=require('../dist/companion/openclawAgentClient');
 // Preserve captured owner fields; only bind the captured row to a disposable Companion ID.
 const key=client.expectedCompanionSessionKey('fixture-session');let row={...fixture.response.sessions[0],key},reads=0,effects=0,delay=fixture._capture.latencyMs;
 client.callOpenClawGateway=async(method,params)=>{
  if(method==='sessions.list'){reads++;if(delay)await new Promise(r=>setTimeout(r,delay));return {...fixture.response,sessions:[structuredClone(row)]};}
  assert.equal(method,'sessions.patch');assert.equal(params.key,key);assert.equal(params.expectedSessionId,row.sessionId);effects++;
  if('model' in params){row.model='different-model';row.modelProvider='openai';row.thinkingOptions=['off','ultra'];row.thinkingLevels=[{id:'off'},{id:'ultra'}];row.thinkingDefault='off';delete row.thinkingLevel;}
  if('thinkingLevel' in params){assert(row.thinkingOptions.includes(params.thinkingLevel));row.thinkingLevel=params.thinkingLevel;}
  return {ok:true,entry:structuredClone(row)};
 };
 const metadata=require('../dist/companion/conversationMetadata'),cache=require('../dist/companion/conversationOwnerIndex');
 try{
  const start=performance.now(),cold=await metadata.readConversationMetadata('fixture-session');assert(performance.now()-start<6000);assert.equal(reads,1);
  assert.deepEqual(cold.thinkingLevels,fixture.response.sessions[0].thinkingOptions);assert.equal(cold.thinkingLevels.length,8);assert.equal(cold.thinkingLevel,'low');assert.equal(cold.thinkingLevelSource,'default');assert.equal(cold.context.percent,8);
  const hot=performance.now();await metadata.readConversationMetadata('fixture-session');assert(performance.now()-hot<1500);assert.equal(reads,1);delay=0;
  for(const level of cold.thinkingLevels){const result=await metadata.changeConversationMetadata('fixture-session',{operationId:'fixture-'+level,thinkingLevel:level});assert.equal(result.state,'completed');}
  assert.equal(effects,8);
  for(let i=1;i<fixture.response.sessions.length;i++){row={...fixture.response.sessions[i],key};cache.invalidateConversationOwner(key);assert.equal((await metadata.readConversationMetadata('fixture-session')).context,null);}
  row={...fixture.response.sessions[0],key};delete row.thinkingOptions;delete row.thinkingLevels;cache.invalidateConversationOwner(key);const absent=await metadata.readConversationMetadata('fixture-session');assert.deepEqual(absent.thinkingLevels,[]);assert.equal(absent.thinkingLevel,null);assert.equal(absent.thinkingLevelSource,null);
  const before=effects;await assert.rejects(metadata.changeConversationMetadata('fixture-session',{operationId:'missing-options',thinkingLevel:'low'}),e=>e.message==='unsupported_thinking_level');assert.equal(effects,before);
  row.thinkingLevels=[{id:'max'},{id:'ultra'}];delete row.thinkingDefault;cache.invalidateConversationOwner(key);assert.deepEqual((await metadata.readConversationMetadata('fixture-session')).thinkingLevels,['max','ultra']);
  await assert.rejects(metadata.changeConversationMetadata('fixture-session',{operationId:'combined',model:'openai/gpt-5.6-sol',thinkingLevel:'ultra'}),e=>e.message==='conversation_settings_must_be_separate');assert.equal(effects,before);
  // A prior model mutation changes the owner's session profile: the next POST re-reads it.
  row.thinkingOptions=['off','ultra'];row.thinkingLevels=[{id:'off'},{id:'ultra'}];row.thinkingDefault='off';delete row.thinkingLevel;
  await assert.rejects(metadata.changeConversationMetadata('fixture-session',{operationId:'new-model-unsupported',thinkingLevel:'max'}),e=>e.message==='unsupported_thinking_level');assert.equal(effects,before);
  assert.equal((await metadata.changeConversationMetadata('fixture-session',{operationId:'new-model-supported',thinkingLevel:'ultra'})).state,'completed');assert.equal(effects,before+1);
  console.log('R18 installed S24 sessions.list fixture: 8 owner options including max/ultra, low default, 8% fresh context, stale/null samples, missing options, fallback ids; measured 2376ms cold/shared warm budgets.');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
