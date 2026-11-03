const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
// Policy flows (Amine 30/10): the immune system and engineering learning become settable through the existing R6
// write path (/agent/config, CAS revision, included-cost allowlist, receipts, replay, revert, inherit), like the
// interpreter. Admitted = qualified native slots of the governor profile (IMMUNE_ENGINEERING, ENGINEERING) in the
// real S24 model_policy.json AND the real plugin LLM policy, never more. Real S24 captures for models/auth/agents,
// model_policy.json and the plugin LLM policy; the private OpenAI profile id and the Claude catalog row are authored.
// Gateway effects are local mocks, never a native acceptance claim.
const captured=require('../fixtures/refonte-model-flows/s24-model-owner-whitelist-20261025.json');
const routing=require('../fixtures/refonte-model-flows/s24-model-policy-routing-20261030.json');
const clone=value=>JSON.parse(JSON.stringify(value));
(async()=>{
 assert.equal(routing.provenance.runtimeCapture,true);assert.equal(captured.provenance.runtimeCapture,true);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'model-flows-policy-'));
 process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;
 await fs.mkdir(path.join(root,'clawmobile-companion'));await fs.mkdir(path.join(root,'skill_intelligence'));
 await fs.writeFile(path.join(root,'clawmobile-companion/runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));
 await fs.writeFile(path.join(root,'skill_intelligence/model_policy.json'),JSON.stringify(routing.policy));
 const ids={'acct-22477f3dabfb':'openai:authored-oauth-fixture','acct-bd186a666d02':'google:claw-gemini-free','acct-edcf442a2103':'github-copilot:authored-token-fixture'};
 const privateRefs=value=>JSON.parse(JSON.stringify(value).replace(/acct-[a-f0-9]{12}/g,key=>ids[key]||key));
 const {publicModelRef}=require('../dist/companion/accountIdentity');
 const plugin={enabled:true,llm:clone(routing.pluginLlm),config:{voiceBargeIn:true}};
 let config={agents:{entries:privateRefs(captured.agents),defaults:{...privateRefs(captured.defaults),compaction:privateRefs(captured.compaction)}},
  plugins:{entries:{'openclaw-plugin-mobile-ui':plugin,openai:{enabled:true},google:{enabled:true},'github-copilot':{enabled:true},anthropic:{enabled:true}}},channels:{privateFixture:'untouched'}};
 let hash='a'.repeat(64),effects=0;const patches=[];
 const auth={providers:captured.auth.map(row=>({...row,profiles:row.profiles.map(p=>({profileId:ids[p.account],type:p.type,status:p.status}))}))};
 // Authored: a Claude catalog row, to prove the CLI-executor slot of ENGINEERING is never an app choice.
 const models=[...clone(captured.models),{id:'claude-sonnet-5-5',provider:'anthropic',available:true,reasoning:true}];
 const merge=(into,patch)=>{for(const [key,value]of Object.entries(patch)){if(value===null){delete into[key];continue;}if(value&&typeof value==='object'&&!Array.isArray(value)){into[key]??={};merge(into[key],value);}else into[key]=value;}};
 const client=require('../dist/companion/openclawAgentClient');
 client.callOpenClawGateway=async(method,params)=>{
  if(method==='config.get')return {config:clone(config),hash};
  if(method==='models.list')return {models:clone(models)};
  if(method==='models.authStatus')return clone(auth);
  if(method==='sessions.list')return {sessions:[],defaults:{}};
  if(method==='sessions.usage')return {};
  assert.equal(method,'config.patch');assert.equal(params.baseHash,hash);
  patches.push(JSON.parse(params.raw));merge(config,JSON.parse(params.raw));effects++;hash=String(effects%10).repeat(64);return {ok:true};
 };
 require('../dist/companion/memoryControl').memoryRemember=async()=>({state:'recorded',event_id:'0'.repeat(64)});
 const metadata=require('../dist/companion/conversationMetadata');
 metadata.preserveModelFlowSessions=async()=>{throw Error('a policy flow pins no conversation session');};
 const owner=require('../dist/companion/modelOwner'),api=require('../dist/companion/agentConfig');
 const {projectModelRoles}=require('../dist/companion/providers');
 const SOL='openai/gpt-5.6-sol',LUNA='openai/gpt-5.6-luna',GEMINI='google/gemini-3.5-flash-lite@google:claw-gemini-free',CLAUDE='anthropic/claude-sonnet-5-5';
 const policy=owner.readIncludedModelPolicy();
 assert.ok(policy&&policy.routing_profiles.IMMUNE_ENGINEERING&&policy.routing_profiles.ENGINEERING);
 assert.deepEqual(owner.policyFlowQualified('immune_system',policy),[SOL,LUNA,GEMINI]);
 assert.deepEqual(owner.policyFlowQualified('engineering_learning',policy),[SOL,LUNA,GEMINI],'Claude (CLI executor) is never admitted');
 assert.deepEqual(owner.policyFlowQualified('immune_system',null),[],'no canonical policy, no admitted model');
 assert.equal(owner.executorFlowReference('immune_system',LUNA+'@openai:authored-oauth-fixture',policy),LUNA);
 assert.equal(owner.executorFlowReference('engineering_learning',CLAUDE,policy),null);
 assert.equal(owner.executorFlowReference('immune_system','google/gemini-3.5-flash-lite@google:other',policy),null,'the free profile is pinned');
 // A disabled slot leaves the admitted set (and the chain) on the next policy read.
 const lunaOff=clone(policy);lunaOff.model_slots.luna.enabled=false;
 assert.deepEqual(owner.policyFlowQualified('immune_system',lunaOff),[SOL,GEMINI]);
 // Absent key: the canonical profile chain, unchanged.
 assert.deepEqual(owner.policyFlowChain(config,'immune_system',policy),{primary:SOL,fallbacks:[LUNA,GEMINI],setting:null,origin:'default'});
 assert.deepEqual(owner.policyFlowChain(config,'engineering_learning',policy),{primary:SOL,fallbacks:[LUNA,CLAUDE,GEMINI],setting:null,origin:'default'});
 try{
  // Read: closed fields, the Gateway LLM policy and included-cost proof only (no Terra, no Copilot, no Claude).
  for(const [flow,profile,continuation] of [['immune_system','IMMUNE_ENGINEERING',[GEMINI]],['engineering_learning','ENGINEERING',[CLAUDE,GEMINI]]]){
   const read=await api.readAgentConfig(flow);
   assert.equal(read.schemaVersion,2);assert.deepEqual(read.writeFields,['model','fallbacks']);assert.equal(read.fastModeSetting,null);assert.equal(read.thinking,null);
   assert.equal(read.model,SOL);assert.deepEqual(read.fallbacks,[LUNA]);assert.equal(read.origins.model,'default');assert.equal(read.writeAvailable,true);
   assert.equal(read.policyProfile,profile);assert.deepEqual(read.policyContinuation,continuation.map(ref=>publicModelRef(ref)));
   assert.deepEqual(read.models.map(row=>row.ref.split('@')[0]).sort(),['google/gemini-3.5-flash-lite','openai/gpt-5.6-luna','openai/gpt-5.6-sol']);
   assert.ok(read.models.every(row=>row.ref.includes('@acct-')&&row.thinkingLevels.length===0&&row.fastModeSupported===false));
   assert.ok(!JSON.stringify(read).includes('authored-oauth-fixture'),'private profile ids never leave');
  }
  const read=await api.readAgentConfig('immune_system');
  const choice=base=>read.models.find(row=>row.ref.startsWith(base+'@')).ref;
  const body={flow:'immune_system',mode:'set',revision:hash,operationId:'immune-set',model:choice('google/gemini-3.5-flash-lite'),fallbacks:[choice(LUNA)]};
  // Refusals before any effect.
  await assert.rejects(api.changeAgentConfig({...body,operationId:'two-fallbacks',fallbacks:[choice(SOL),choice(LUNA)]}),e=>e.statusCode===400);
  await assert.rejects(api.changeAgentConfig({...body,operationId:'self-fallback',fallbacks:[choice('google/gemini-3.5-flash-lite')]}),e=>e.statusCode===400);
  await assert.rejects(api.changeAgentConfig({...body,operationId:'thinking-field',thinking:'low'}),e=>e.statusCode===400);
  await assert.rejects(api.changeAgentConfig({...body,operationId:'no-fallbacks-field',fallbacks:undefined}),e=>e.statusCode===400);
  await assert.rejects(api.changeAgentConfig({...body,operationId:'terra',model:'openai/gpt-5.6-terra'}),e=>e.statusCode===409&&e.message==='model_flow_model_not_included');
  await assert.rejects(api.changeAgentConfig({...body,operationId:'claude',flow:'engineering_learning',model:CLAUDE,fallbacks:[]}),e=>e.statusCode===409&&e.message==='model_flow_model_not_included');
  await assert.rejects(api.changeAgentConfig({...body,operationId:'stale',revision:'b'.repeat(64)}),e=>e.statusCode===409&&e.message==='agent_config_revision_changed');
  assert.equal(effects,0);
  const agentsBefore=clone(config.agents),channelsBefore=clone(config.channels),llmBefore=clone(plugin.llm);
  // Gemini free is already the immune last resort: making it first adds no account, so no biometric challenge.
  const set=await api.changeAgentConfig(body);
  assert.equal(set.state,'completed');assert.equal(set.receipt.version,2);assert.equal(set.receipt.flow,'immune_system');assert.equal(effects,1);
  assert.deepEqual(config.plugins.entries['openclaw-plugin-mobile-ui'].config.immuneModelFlow,{version:1,model:{primary:GEMINI,fallbacks:[LUNA+'@openai:authored-oauth-fixture']}});
  assert.deepEqual(patches[0],{plugins:{entries:{'openclaw-plugin-mobile-ui':{config:{immuneModelFlow:{version:1,model:{primary:GEMINI,fallbacks:[LUNA+'@openai:authored-oauth-fixture']}}}}}}},'one scoped key, no R6 proof, no agent field');
  assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.modelFlowSelection,undefined,'no conversation fence for a policy flow');
  assert.deepEqual(config.agents,agentsBefore);assert.deepEqual(config.channels,channelsBefore);assert.deepEqual(config.plugins.entries['openclaw-plugin-mobile-ui'].llm,llmBefore);
  assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.voiceBargeIn,true);
  // The governor's order: the setting first, then the rest of the profile (Sol stays as the safety net).
  assert.deepEqual(owner.policyFlowChain(config,'immune_system',policy),{primary:GEMINI,fallbacks:[LUNA,SOL],setting:{primary:GEMINI,fallbacks:[LUNA]},origin:'flow'});
  assert.deepEqual(await api.changeAgentConfig(body),set);assert.equal(effects,1,'same operation never dispatches twice');
  const after=await api.readAgentConfig('immune_system');
  assert.equal(after.model,publicModelRef(GEMINI));assert.deepEqual(after.fallbacks,[publicModelRef(LUNA+'@openai:authored-oauth-fixture')]);assert.equal(after.origins.model,'flow');
  assert.equal(after.previousReceiptRunId,set.receipt.runId);assert.deepEqual(after.policyContinuation,[SOL]);
  // Engineering: one model, no fallback; the rest of ENGINEERING (Claude included) still follows in policy order.
  const engineering=await api.changeAgentConfig({flow:'engineering_learning',mode:'set',revision:hash,operationId:'engineering-set',model:choice(LUNA),fallbacks:[]});
  assert.equal(engineering.state,'completed');assert.equal(effects,2);
  assert.deepEqual(config.plugins.entries['openclaw-plugin-mobile-ui'].config.engineeringModelFlow,{version:1,model:{primary:LUNA+'@openai:authored-oauth-fixture',fallbacks:[]}});
  assert.deepEqual(owner.policyFlowChain(config,'engineering_learning',policy).fallbacks,[SOL,CLAUDE,GEMINI]);
  assert.ok(config.plugins.entries['openclaw-plugin-mobile-ui'].config.immuneModelFlow,'one flow never rewrites the other');
  // /providers shows the effective chain from the same owner snapshot shape.
  owner.observeVerifiedModelOwnerConfig({raw:{config:clone(config),hash},catalog:{models:clone(models)},auth:clone(auth),policy});
  let roles=projectModelRoles(owner.peekModelOwner()),find=id=>roles.find(row=>row.id===id);
  assert.equal(find('immune_system').model,'google/gemini-3.5-flash-lite');assert.deepEqual(find('immune_system').fallbacks,[LUNA,SOL]);
  assert.equal(find('immune_system').source,'gateway_config');assert.equal(find('immune_system').editable,true);assert.deepEqual(find('immune_system').writeFields,['model','fallbacks']);
  assert.equal(find('immune_system').policyProfile,'IMMUNE_ENGINEERING');assert.equal(find('immune_system').origins.model,'flow');
  assert.equal(find('engineering_learning').model,LUNA);assert.deepEqual(find('engineering_learning').fallbacks,[SOL,CLAUDE,'google/gemini-3.5-flash-lite']);
  assert.equal(find('engineering_learning').policyProfile,'ENGINEERING');
  // Revert restores the exact previous absence; « hériter » removes the key; the plugin config keeps its other keys.
  const reverted=await api.changeAgentConfig({flow:'immune_system',mode:'revert',revision:hash,operationId:'immune-revert',restoreRunId:set.receipt.runId});
  assert.equal(reverted.state,'completed');assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.immuneModelFlow,undefined);
  const inherit=await api.changeAgentConfig({flow:'engineering_learning',mode:'inherit',revision:hash,operationId:'engineering-inherit'});
  assert.equal(inherit.state,'completed');assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.engineeringModelFlow,undefined);
  assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.voiceBargeIn,true);
  assert.equal(owner.policyFlowChain(config,'immune_system',policy).origin,'default');assert.equal(owner.policyFlowChain(config,'engineering_learning',policy).origin,'default');
  // A malformed or unqualified stored value is ignored by every reader (profile chain kept) and shown as such.
  for(const tampered of [{version:1,model:{primary:CLAUDE,fallbacks:[]}},{version:1,model:{primary:SOL,fallbacks:[SOL]}},{version:1,model:{primary:SOL,fallbacks:[LUNA,GEMINI]}},{version:2,model:{primary:SOL,fallbacks:[]}},'openai/gpt-5.6-sol']){
   const shaped=clone(config);shaped.plugins.entries['openclaw-plugin-mobile-ui'].config.engineeringModelFlow=tampered;
   assert.deepEqual(owner.policyFlowChain(shaped,'engineering_learning',policy),{primary:SOL,fallbacks:[LUNA,CLAUDE,GEMINI],setting:null,origin:'default'});
  }
  const tampered=clone(config);tampered.plugins.entries['openclaw-plugin-mobile-ui'].config.engineeringModelFlow={version:1,model:{primary:CLAUDE,fallbacks:[]}};
  owner.observeVerifiedModelOwnerConfig({raw:{config:tampered,hash},catalog:{models:clone(models)},auth:clone(auth),policy});
  roles=projectModelRoles(owner.peekModelOwner());
  assert.equal(find('engineering_learning').model,SOL);assert.deepEqual(find('engineering_learning').issues,['model_flow_setting_ignored']);assert.equal(find('engineering_learning').source,'model_policy');
  // Without a readable canonical policy: no chain, no choice, nothing written.
  const noPolicy=projectModelRoles({...owner.peekModelOwner(),policy:null});
  assert.equal(noPolicy.find(row=>row.id==='engineering_learning').editableReason,'model_policy_unavailable');
  await fs.rm(path.join(root,'skill_intelligence/model_policy.json'));
  const blind=await api.readAgentConfig('immune_system');assert.equal(blind.models.length,0);assert.equal(blind.writeAvailable,false);
  await assert.rejects(api.changeAgentConfig({flow:'immune_system',mode:'set',revision:hash,operationId:'no-policy',model:choice(SOL),fallbacks:[]}),e=>e.statusCode===409&&e.message==='included_model_policy_unavailable');
  assert.equal(effects,4);
 }finally{await fs.rm(root,{recursive:true,force:true});}
 console.log('policy model flows: immune system and engineering learning settable (primary + one fallback) via the R6 CAS path; qualified profile slots AND plugin LLM policy only (no Claude, no Terra), scoped keys, no conversation fence, replay/revert/inherit, governor order (setting then rest of the profile) and fallback to the policy chain passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
