const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
// Real S24 shape/values, then explicitly authored private identities and mutation
// scenarios. These effects are local mocks, never a native acceptance claim.
const captured=require('../fixtures/refonte-model-flows/s24-model-owner-whitelist-20261025.json');
const policyCapture=require('../fixtures/refonte-model-flows/s24-policy-voice-memory-whitelist-20261025.json');
const clone=value=>JSON.parse(JSON.stringify(value));
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'model-flows-'));
 process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;process.env.SAMANTHA_BRAIN_ONLY='1';
 await fs.mkdir(path.join(root,'clawmobile-companion'));await fs.mkdir(path.join(root,'skill_intelligence'));
 await fs.writeFile(path.join(root,'clawmobile-companion/runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));
 const ids={'acct-22477f3dabfb':'openai:authored-oauth-fixture','acct-bd186a666d02':'google:authored-free-fixture','acct-edcf442a2103':'github-copilot:authored-token-fixture'};
 const privateRefs=value=>JSON.parse(JSON.stringify(value).replace(/acct-[a-f0-9]{12}/g,key=>ids[key]||key));
 const {accountAlias,publicModelRef}=require('../dist/companion/accountIdentity');
 const policy={authentication:'subscription_only',primary:policyCapture.modelPolicy.primary,fallback:policyCapture.modelPolicy.fallback,
  model_slots:Object.fromEntries(Object.entries(policyCapture.modelPolicy.slots).map(([key,row])=>[key,{enabled:row.enabled,provider:row.provider,model:privateRefs(row.model??null),cost_policy:row.costPolicy,executor:row.executor,qualification_ref:row.qualificationRef}]))};
 await fs.writeFile(path.join(root,'skill_intelligence/model_policy.json'),JSON.stringify(policy));
 let config={agents:{entries:privateRefs(captured.agents),defaults:privateRefs(captured.defaults)},plugins:{entries:{'openclaw-plugin-mobile-ui':{enabled:true},openai:{enabled:true},google:{enabled:true},'github-copilot':{enabled:true}}},
  channels:{privateFixture:'untouched'},payments:{privateFixture:'untouched'}};
 for(const id of ['main','contacts','contacts-projet','contacts-pulse','contacts-projet-pulse'])Object.assign(config.agents.entries[id],{identity:{name:id},workspace:'authored:'+id,tools:{deny:['fixture-private-tool']},skills:['fixture-isolation']});
 let hash='a'.repeat(64),effects=0,patchFail=null,afterPatchReadFail=false,preserved=[];
 const auth={providers:captured.auth.map(row=>({...row,profiles:row.profiles.map(p=>({profileId:ids[p.account],type:p.type,status:p.status}))}))};
 const merge=(into,patch)=>{for(const [key,value]of Object.entries(patch)){if(value===null){delete into[key];continue;}if(value&&typeof value==='object'&&!Array.isArray(value)){into[key]??={};merge(into[key],value);}else into[key]=value;}};
 const client=require('../dist/companion/openclawAgentClient');
 client.callOpenClawGateway=async(method,params)=>{
  if(method==='config.get'){if(afterPatchReadFail)throw Error('authored-readback-unavailable');return {config:clone(config),hash};}
  if(method==='models.list')return {models:clone(captured.models)};
  if(method==='models.authStatus')return clone(auth);
  if(method==='sessions.list')return {sessions:[],defaults:{}};
  if(method==='sessions.usage')return {};
  assert.equal(method,'config.patch');assert.equal(params.baseHash,hash);
  assert.equal(preserved.length>effects,true,'native session preservation must complete before a patch');
  const activity=await require('../dist/companion/runs').readModelFlowConfigurationActivity();assert.ok(activity.length>0,'reservation is durable before dispatch');
  if(patchFail==='before')throw Object.assign(Error('ECONNREFUSED'),{code:'ECONNREFUSED'});
  merge(config,JSON.parse(params.raw));effects++;hash=String(effects%10).repeat(64);
  if(patchFail==='late')throw Error('authored-late-gateway-error');
  if(patchFail==='unknown')afterPatchReadFail=true;
  return {ok:true};
 };
 require('../dist/companion/memoryControl').memoryRemember=async()=>({state:'recorded',event_id:'0'.repeat(64)});
 const owner=require('../dist/companion/modelOwner'),api=require('../dist/companion/agentConfig'),metadata=require('../dist/companion/conversationMetadata');
 try{
  const read=await api.readAgentConfig('brain');assert.equal(read.schemaVersion,2);assert.equal(read.model,publicModelRef(config.agents.entries.main.model.primary));
  assert.deepEqual(owner.MODEL_FLOW_IDS.length,11);assert.equal(read.models.length,4,'three subscription models and exact canonical free model');
  assert.ok(read.models.every(row=>row.ref.includes('@acct-')&&!row.ref.includes('authored-')));
  assert.ok(!read.models.some(row=>row.provider==='github-copilot'),'available token does not attest free admission');
  assert.ok(!JSON.stringify(read).includes('authored-'));assert.ok(!JSON.stringify(read).includes('privateFixture'));
  require('../dist/companion/conversationOwnerIndex').observeConversationOwnerRow({key:client.expectedCompanionSessionKey('flowfixture'),sessionId:'authored-native-session',model:'gpt-5.6-sol',modelProvider:'openai',label:'Fixture',pinned:false,hasActiveRun:false,permissionModePending:false});
  const conversation=await metadata.readConversationMetadata('flowfixture');
  assert.equal(conversation.models.length,4,'conversation override also uses the included-cost owner');
  assert.ok(conversation.models.every(ref=>ref.includes('@acct-')));assert.ok(!conversation.models.some(ref=>ref.startsWith('github-copilot/')));
  const publicKey=read.models.find(row=>row.provider==='google').ref;
  const dangerous={...auth,providers:auth.providers.map(row=>row.provider==='openai'?{...row,profiles:[{profileId:'openai:authored-api-fixture',type:'api_key',status:'static'}]}:row)};
  assert.deepEqual(owner.includedModelAccounts('openai/gpt-5.6-sol',dangerous,owner.readIncludedModelPolicy()),[]);
  assert.deepEqual(owner.includedModelAccounts('google/other',auth,owner.readIncludedModelPolicy()),[]);
  const brain={flow:'brain',mode:'set',revision:hash,operationId:'unqualified-sessions',model:read.model,thinking:'medium',fallbacks:[],fastMode:true};
  const blocked=await api.changeAgentConfig(brain);assert.equal(blocked.state,'refused');assert.equal(blocked.artifact.reason,'model_flow_preservation_unqualified');assert.equal(effects,0,'missing native preservation must fail closed');
  // SDK integration is a separate owner/test: simulate an explicitly verified native result here.
  metadata.preserveModelFlowSessions=async(flow,before,operationId)=>{preserved.push({flow,operationId});return {state:'verified',preserved:2};};
  const beforeProtected=clone({channels:config.channels,payments:config.payments,contacts:config.agents.entries.contacts});
  const changed=await api.changeAgentConfig({...brain,operationId:'brain-edit'});assert.equal(changed.state,'completed');assert.equal(effects,1);assert.equal(changed.receipt.version,2);
  assert.deepEqual(await api.changeAgentConfig({...brain,operationId:'brain-edit'}),changed);assert.equal(effects,1,'same action does not dispatch twice');
  assert.deepEqual({channels:config.channels,payments:config.payments,contacts:config.agents.entries.contacts},beforeProtected,'brain change preserves contacts, channels and payment config');
  const challengeBody={...brain,operationId:'new-primary-provider',revision:hash,model:publicKey,thinking:'low',fastMode:false};
  await assert.rejects(api.changeAgentConfig(challengeBody),error=>error.statusCode===403&&error.confirmation.reference==='flow:brain'&&/^[a-f0-9]{64}$/.test(error.confirmation.payloadHash));assert.equal(effects,1,'new PRIMARY provider also requires biometrics');
  const old=clone(config.agents.entries.main);
  const selected=await api.readAgentConfig('brain');const next=await api.changeAgentConfig({...brain,operationId:'brain-next',revision:hash,thinking:'high'});assert.equal(next.state,'completed');
  const restored=await api.changeAgentConfig({flow:'brain',mode:'revert',revision:hash,operationId:'brain-revert',restoreRunId:next.receipt.runId});assert.equal(restored.state,'completed');assert.deepEqual(config.agents.entries.main,old,'revert restores exact owned fields and preserves unrelated keys');
  const waBefore=Object.fromEntries(owner.CONTACT_MODEL_AGENTS.map(id=>[id,clone(config.agents.entries[id])]));
  const waView=await api.readAgentConfig('whatsapp');
  const waBody={flow:'whatsapp',mode:'set',revision:hash,operationId:'wa',model:waView.model,thinking:'low',fallbacks:[],fastMode:true};
  const wa=await api.changeAgentConfig(waBody);assert.equal(wa.state,'completed');
  for(const id of owner.CONTACT_MODEL_AGENTS){const expected=waBefore[id];expected.model={primary:config.agents.entries[id].model.primary,fallbacks:[]};assert.deepEqual(config.agents.entries[id],expected,'contact identity/workspace/tools/memory policy do not move');}
  assert.equal(config.plugins.entries['openclaw-plugin-mobile-ui'].config.whatsappModelFlow.version,1);
  await assert.rejects(api.changeAgentConfig({...waBody,operationId:'stale-wa'}),e=>e.statusCode===409&&e.message==='agent_config_revision_changed');
  const summary=await api.readAgentConfig('conversation_summary');assert.deepEqual(summary.writeFields,['model']);assert.equal(summary.thinking,null);assert.equal(summary.fastMode,null);
  const summaryResult=await api.changeAgentConfig({flow:'conversation_summary',mode:'set',revision:hash,operationId:'summary',model:read.model});assert.equal(summaryResult.state,'completed');assert.equal(preserved.at(-1).flow,'conversation_summary');
  patchFail='late';const late=await api.changeAgentConfig({...brain,revision:hash,operationId:'late-effect',thinking:'high'});assert.equal(late.state,'completed','readback can prove an effect despite late response loss');
  patchFail='unknown';const unknownBody={...brain,revision:hash,operationId:'unknown-effect',thinking:'low'};const uncertain=await api.changeAgentConfig(unknownBody);assert.equal(uncertain.state,'indeterminate');const count=effects;
  assert.equal((await api.changeAgentConfig(unknownBody)).state,'indeterminate');assert.equal(effects,count,'uncertain effect is never replayed');
  assert.ok((await require('../dist/companion/runs').readModelFlowConfigurationActivity()).some(row=>row.flow==='brain'),'uncertain outcome keeps new-session admission fenced');
  afterPatchReadFail=false;
  const runStatus=await require('../dist/companion/runs').getRunStatus(uncertain.receipt.runId);
  const reconciled=await api.reconcileModelFlowRunStatus(runStatus);assert.equal(JSON.parse(reconciled.result).state,'completed');assert.equal(effects,count,'status readback reconciles the same receipt without repeating configuration');
  assert.deepEqual(await require('../dist/companion/runs').readModelFlowConfigurationActivity(),[],'verified same-action readback releases admission');
  console.log('L5 real S24 projection; authored local owner effects: included billing admission, account redaction, primary biometric guard, exact CAS/replay/revert, contact isolation, summary preservation and uncertain-effect fence passed');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
