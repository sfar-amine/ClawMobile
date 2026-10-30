const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
// Executor flows (Amine 30/10): intent interpreter, public web synthesis and voice memo transcription become
// settable through the existing R6 write path (/agent/config, CAS revision, included-cost allowlist, receipts,
// revert). Real S24 captures for models/auth/agents, model_policy.json and the plugin LLM policy; the private
// OpenAI profile id is authored. Gateway effects are local mocks, never a native acceptance claim.
const captured=require('../fixtures/refonte-model-flows/s24-model-owner-whitelist-20261025.json');
const routing=require('../fixtures/refonte-model-flows/s24-model-policy-routing-20261030.json');
const clone=value=>JSON.parse(JSON.stringify(value));
(async()=>{
 assert.equal(routing.provenance.runtimeCapture,true);assert.equal(captured.provenance.runtimeCapture,true);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'model-flows-executors-'));
 process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;delete process.env.SAMANTHA_BRAIN_ONLY;
 await fs.mkdir(path.join(root,'clawmobile-companion'));await fs.mkdir(path.join(root,'skill_intelligence'));
 await fs.writeFile(path.join(root,'clawmobile-companion/runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));
 await fs.writeFile(path.join(root,'skill_intelligence/model_policy.json'),JSON.stringify(routing.policy));
 // The Gemini free alias of the capture is the real `google:claw-gemini-free` profile; the OpenAI one is authored.
 const ids={'acct-22477f3dabfb':'openai:authored-oauth-fixture','acct-bd186a666d02':'google:claw-gemini-free','acct-edcf442a2103':'github-copilot:authored-token-fixture'};
 const privateRefs=value=>JSON.parse(JSON.stringify(value).replace(/acct-[a-f0-9]{12}/g,key=>ids[key]||key));
 const {accountAlias,publicModelRef}=require('../dist/companion/accountIdentity');
 assert.equal(accountAlias('google:claw-gemini-free'),'acct-bd186a666d02');
 const plugin={enabled:true,llm:clone(routing.pluginLlm),config:{voiceBargeIn:true}};
 let config={agents:{entries:privateRefs(captured.agents),defaults:{...privateRefs(captured.defaults),compaction:privateRefs(captured.compaction)}},
  plugins:{entries:{'openclaw-plugin-mobile-ui':plugin,openai:{enabled:true},google:{enabled:true},'github-copilot':{enabled:true}}},channels:{privateFixture:'untouched'}};
 let hash='a'.repeat(64),effects=0;const patches=[];
 const auth={providers:captured.auth.map(row=>({...row,profiles:row.profiles.map(p=>({profileId:ids[p.account],type:p.type,status:p.status}))}))};
 const merge=(into,patch)=>{for(const [key,value]of Object.entries(patch)){if(value===null){delete into[key];continue;}if(value&&typeof value==='object'&&!Array.isArray(value)){into[key]??={};merge(into[key],value);}else into[key]=value;}};
 const client=require('../dist/companion/openclawAgentClient');
 client.callOpenClawGateway=async(method,params)=>{
  if(method==='config.get')return {config:clone(config),hash};
  if(method==='models.list')return {models:clone(captured.models)};
  if(method==='models.authStatus')return clone(auth);
  if(method==='sessions.list')return {sessions:[],defaults:{}};
  if(method==='sessions.usage')return {};
  assert.equal(method,'config.patch');assert.equal(params.baseHash,hash);
  patches.push(JSON.parse(params.raw));merge(config,JSON.parse(params.raw));effects++;hash=String(effects%10).repeat(64);return {ok:true};
 };
 require('../dist/companion/memoryControl').memoryRemember=async()=>({state:'recorded',event_id:'0'.repeat(64)});
 const metadata=require('../dist/companion/conversationMetadata');
 metadata.preserveModelFlowSessions=async()=>{throw Error('an executor flow pins no conversation session');};
 const owner=require('../dist/companion/modelOwner'),api=require('../dist/companion/agentConfig'),port=require('../dist/intentInterpreterPort');
 const {projectModelRoles}=require('../dist/companion/providers');
 const SOL='openai/gpt-5.6-sol',LUNA='openai/gpt-5.6-luna',GEMINI='google/gemini-3.5-flash-lite@google:claw-gemini-free';
 assert.deepEqual([...owner.EXECUTOR_FLOW_QUALIFIED.intent_interpreter],[SOL,LUNA,GEMINI]);
 assert.deepEqual(owner.executorFlowChain(config,'intent_interpreter'),{primary:port.INTERPRETER_PRIMARY,fallbacks:[port.INTERPRETER_FALLBACK],origin:'default'},'absent key keeps the current constant chain');
 try{
  // Read: closed fields, the Gateway LLM policy and included-cost proof only (no Terra, no Copilot).
  const read=await api.readAgentConfig('intent_interpreter');
  assert.equal(read.schemaVersion,2);assert.deepEqual(read.writeFields,['model','fallbacks']);assert.equal(read.fastModeSetting,null);assert.equal(read.thinking,null);
  assert.equal(read.model,SOL);assert.deepEqual(read.fallbacks,[publicModelRef(GEMINI)]);assert.equal(read.origins.model,'default');assert.equal(read.writeAvailable,true);
  const refs=read.models.map(row=>row.ref).sort();
  assert.deepEqual(refs.map(ref=>ref.split('@')[0]),['google/gemini-3.5-flash-lite','openai/gpt-5.6-luna','openai/gpt-5.6-sol']);
  assert.ok(read.models.every(row=>row.ref.includes('@acct-')&&row.thinkingLevels.length===0&&row.fastModeSupported===false));
  assert.ok(!JSON.stringify(read).includes('authored-oauth-fixture'),'private profile ids never leave');
  const choice=base=>read.models.find(row=>row.ref.startsWith(base+'@')).ref;
  const body={flow:'intent_interpreter',mode:'set',revision:hash,operationId:'interp-set',model:choice(LUNA),fallbacks:[choice('google/gemini-3.5-flash-lite')]};
  // Refusals before any effect.
  await assert.rejects(api.changeAgentConfig({...body,operationId:'two-fallbacks',fallbacks:[choice(SOL),choice('google/gemini-3.5-flash-lite')]}),e=>e.statusCode===400);
  await assert.rejects(api.changeAgentConfig({...body,operationId:'self-fallback',fallbacks:[choice(LUNA)]}),e=>e.statusCode===400);
  await assert.rejects(api.changeAgentConfig({...body,operationId:'thinking-field',thinking:'low'}),e=>e.statusCode===400);
  await assert.rejects(api.changeAgentConfig({...body,operationId:'terra',model:'openai/gpt-5.6-terra'}),e=>e.statusCode===409&&e.message==='model_flow_model_not_included');
  await assert.rejects(api.changeAgentConfig({...body,operationId:'stale',revision:'b'.repeat(64)}),e=>e.statusCode===409&&e.message==='agent_config_revision_changed');
  assert.equal(effects,0);
  const agentsBefore=clone(config.agents),channelsBefore=clone(config.channels),llmBefore=clone(plugin.llm);
  const set=await api.changeAgentConfig(body);
  assert.equal(set.state,'completed');assert.equal(set.receipt.version,2);assert.equal(set.receipt.flow,'intent_interpreter');assert.equal(effects,1);
  assert.deepEqual(config.plugins.entries['openclaw-plugin-mobile-ui'].config.interpreterModelFlow,{version:1,model:{primary:LUNA+'@openai:authored-oauth-fixture',fallbacks:[GEMINI]}});
  assert.deepEqual(patches[0],{plugins:{entries:{'openclaw-plugin-mobile-ui':{config:{interpreterModelFlow:{version:1,model:{primary:LUNA+'@openai:authored-oauth-fixture',fallbacks:[GEMINI]}}}}}}},'one scoped key, no R6 proof, no agent field');
  assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.modelFlowSelection,undefined,'no conversation fence for an executor flow');
  assert.deepEqual(config.agents,agentsBefore);assert.deepEqual(config.channels,channelsBefore);assert.deepEqual(config.plugins.entries['openclaw-plugin-mobile-ui'].llm,llmBefore);
  assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.voiceBargeIn,true);
  assert.deepEqual(owner.executorFlowChain(config,'intent_interpreter'),{primary:LUNA,fallbacks:[GEMINI],origin:'flow'},'runtime reader maps the account suffix to the qualified port reference');
  assert.ok(port.validateRequest({systemPrompt:'x',message:'y',model:LUNA}),'the port admits the configured chain');
  assert.deepEqual(await api.changeAgentConfig(body),set);assert.equal(effects,1,'same operation never dispatches twice');
  const after=await api.readAgentConfig('intent_interpreter');assert.equal(after.model,publicModelRef(LUNA+'@openai:authored-oauth-fixture'));assert.equal(after.origins.model,'flow');assert.equal(after.previousReceiptRunId,set.receipt.runId);
  // The providers projection shows the setting (source, chain) from the same owner snapshot shape.
  owner.observeVerifiedModelOwnerConfig({raw:{config:clone(config),hash},catalog:{models:clone(captured.models)},auth:clone(auth),policy:owner.readIncludedModelPolicy()});
  let role=projectModelRoles(owner.peekModelOwner()).find(row=>row.id==='intent_interpreter');
  assert.equal(role.model,LUNA);assert.deepEqual(role.fallbacks,['google/gemini-3.5-flash-lite']);assert.equal(role.source,'gateway_config');assert.equal(role.editable,true);assert.deepEqual(role.writeFields,['model','fallbacks']);
  // Revert restores the exact previous absence; the plugin config keeps its other keys.
  const reverted=await api.changeAgentConfig({flow:'intent_interpreter',mode:'revert',revision:hash,operationId:'interp-revert',restoreRunId:set.receipt.runId});
  assert.equal(reverted.state,'completed');assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.interpreterModelFlow,undefined);assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.voiceBargeIn,true);
  assert.equal(owner.executorFlowChain(config,'intent_interpreter').origin,'default');
  // Web synthesis and memo transcription: one qualified free model each until another one is qualified.
  for(const [flow,key,qualified] of [['web_search','webSearchModelFlow','google/gemini-3.5-flash-lite@google:claw-gemini-free'],['voice_memos','voiceMemoModelFlow','google/gemini-3.5-flash-lite@google:claw-gemini-free']]){
   const view=await api.readAgentConfig(flow);assert.deepEqual(view.writeFields,['model']);assert.equal(view.models.length,1);assert.equal(view.models[0].ref,publicModelRef(qualified));
   await assert.rejects(api.changeAgentConfig({flow,mode:'set',revision:hash,operationId:flow+'-fallbacks',model:view.models[0].ref,fallbacks:[]}),e=>e.statusCode===400,'no fallback field');
   await assert.rejects(api.changeAgentConfig({flow,mode:'set',revision:hash,operationId:flow+'-sol',model:read.models.find(row=>row.ref.startsWith(SOL+'@')).ref}),e=>e.statusCode===409);
   const done=await api.changeAgentConfig({flow,mode:'set',revision:hash,operationId:flow+'-set',model:view.models[0].ref});assert.equal(done.state,'completed');
   assert.deepEqual(config.plugins.entries['openclaw-plugin-mobile-ui'].config[key],{version:1,model:{primary:qualified,fallbacks:[]}});
   assert.deepEqual(owner.executorFlowChain(config,flow),{primary:qualified,fallbacks:[],origin:'flow'});
   const inherit=await api.changeAgentConfig({flow,mode:'inherit',revision:hash,operationId:flow+'-inherit'});assert.equal(inherit.state,'completed');assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config[key],undefined);
  }
  // A malformed or unqualified stored value is ignored by every reader (constant kept) and shown as such.
  const tampered=clone(config);tampered.plugins.entries['openclaw-plugin-mobile-ui'].config.interpreterModelFlow={version:1,model:{primary:'openai/gpt-5.6-terra',fallbacks:[]}};
  assert.equal(owner.executorFlowChain(tampered,'intent_interpreter').origin,'default');
  owner.observeVerifiedModelOwnerConfig({raw:{config:tampered,hash},catalog:{models:clone(captured.models)},auth:clone(auth),policy:owner.readIncludedModelPolicy()});
  role=projectModelRoles(owner.peekModelOwner()).find(row=>row.id==='intent_interpreter');
  assert.equal(role.model,SOL);assert.deepEqual(role.issues,['model_flow_setting_ignored']);assert.equal(role.source,'code_constant');
  const duplicate=clone(config);duplicate.plugins.entries['openclaw-plugin-mobile-ui'].config.interpreterModelFlow={version:1,model:{primary:GEMINI,fallbacks:[GEMINI]}};
  assert.equal(owner.executorFlowChain(duplicate,'intent_interpreter').origin,'default');
  // Engineering/immune read the canonical routing profiles, never the engineering-lite agent default.
  const roles=projectModelRoles(owner.peekModelOwner()),find=id=>roles.find(row=>row.id===id);
  assert.deepEqual(roles.map(row=>row.id),owner.MODEL_FLOW_IDS);
  assert.equal(find('engineering_learning').source,'model_policy');assert.equal(find('engineering_learning').model,SOL);
  assert.deepEqual(find('engineering_learning').fallbacks,['openai/gpt-5.6-luna','anthropic/claude-sonnet-5-5','google/gemini-3.5-flash-lite']);
  assert.deepEqual(find('immune_system').fallbacks,['openai/gpt-5.6-luna','google/gemini-3.5-flash-lite']);assert.equal(find('immune_system').policyProfile,'IMMUNE_ENGINEERING');
  assert.equal(find('memory_search').editableReason,'memory_reindex_required');assert.equal(find('realtime_voice').editableReason,'qualified_live_protocol');
  assert.ok(['intent_interpreter','web_search','voice_memos','brain','conversation_summary','whatsapp'].every(id=>find(id).editable===true));
  // The legacy single-agent write stays admitted: an executor setting creates no conversation fence.
  assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.modelFlowSelection,undefined);
 }finally{await fs.rm(root,{recursive:true,force:true});}
 console.log('executor model flows: interpreter (primary + one fallback), web synthesis and memo transcription settable via the R6 CAS path; qualified-only choices, scoped key, no conversation fence, replay/revert/inherit, runtime fallback to constants and policy-routed engineering/immune roles passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
