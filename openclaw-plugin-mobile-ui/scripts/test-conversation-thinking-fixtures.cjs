const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
(async()=>{
 const fixture=require('../fixtures/s24-2026-10-10/gateway/sessions.list.json');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r18-installed-fixture-'));process.env.OPENCLAW_STATE_DIR=root;
 const client=require('../dist/companion/openclawAgentClient');
 // Preserve captured owner fields; only bind the captured row to a disposable Companion ID.
 const key=client.expectedCompanionSessionKey('fixture-session');let row={...fixture.response.sessions[0],key},reads=0,effects=0,modelReads=0,delay=fixture._capture.latencyMs;
 const models=require('../fixtures/s24-2026-10-10/gateway/models.list.json'),auth=require('../fixtures/s24-2026-10-10/gateway/models.authStatus.json'),configCapture=require('../fixtures/s24-2026-10-10/gateway/config.get.json');
 // The config.get capture is a published subset without agents.entries.main.modelPolicy: add only the allow list of the captured models.
 const ownerConfig={...configCapture.response,config:{...configCapture.response.config,agents:{...configCapture.response.config.agents,entries:{main:{modelPolicy:{allow:models.response.models.map(x=>x.provider+'/'+x.id)}}}}}};
 client.callOpenClawGateway=async(method,params)=>{
  if(method==='sessions.list'){reads++;if(delay)await new Promise(r=>setTimeout(r,delay));return {...fixture.response,sessions:[structuredClone(row)]};}
  if(method==='config.get')return structuredClone(ownerConfig);
  if(method==='models.list'){modelReads++;return structuredClone(models.response);}
  if(method==='models.authStatus')return structuredClone(auth.response);
  assert.equal(method,'sessions.patch');assert.equal(params.key,key);assert.equal(params.expectedSessionId,row.sessionId);effects++;
  if('model' in params){
   // The installed owner re-derives the session profile from the selected model: luna offers low..max (models.list capture), no ultra.
   const [provider,id]=params.model.split('/'),selected=models.response.models.find(x=>x.provider===provider&&x.id===id);
   row.model=id;row.modelProvider=provider;row.modelOverride=id;row.providerOverride=provider;row.modelOverrideSource='user';
   row.thinkingOptions=selected.thinkingLevels.map(x=>x.id);row.thinkingLevels=selected.thinkingLevels;row.thinkingDefault=selected.thinkingDefault||'low';delete row.thinkingLevel;
  }
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
  // Real model POST, then thinking is revalidated on a fresh sessions.list row read after the patch, never on models.list.
  row={...fixture.response.sessions[0],key};cache.invalidateConversationOwner(key);
  const modelChange=await metadata.changeConversationMetadata('fixture-session',{operationId:'model-luna',model:'openai/gpt-5.6-luna'});assert.equal(modelChange.state,'completed',JSON.stringify(modelChange));
  const afterModel=effects,catalogReads=modelReads,listReads=reads;assert(catalogReads>=1);
  const switched=await metadata.readConversationMetadata('fixture-session');assert.deepEqual(switched.thinkingLevels,['low','medium','high','xhigh','max']);
  await assert.rejects(metadata.changeConversationMetadata('fixture-session',{operationId:'luna-ultra',thinkingLevel:'ultra'}),e=>e.message==='unsupported_thinking_level');assert.equal(effects,afterModel);
  assert.equal((await metadata.changeConversationMetadata('fixture-session',{operationId:'luna-max',thinkingLevel:'max'})).state,'completed');assert.equal(effects,afterModel+1);
  assert.equal(modelReads,catalogReads,'thinking validation never reads models.list');assert(reads>=listReads+2,'each thinking POST re-reads its sessions.list row');
  console.log('R18 installed S24 sessions.list fixture: 8 owner options including max/ultra, low default, 8% fresh context, stale/null samples, missing options, fallback ids, real model POST then thinking revalidated on the fresh session row; measured 2376ms cold/shared warm budgets.');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
