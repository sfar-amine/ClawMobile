// Model profile setup on the actual hashed SDK functions, per pinned OpenClaw version:
//   node test-model-flow-setup.cjs            -> 2026.9.6 (S24 production capture, unchanged)
//   node test-model-flow-setup.cjs 2026.10.9  -> upgrade candidate (public npm modules)
const assert=require('node:assert/strict'),vm=require('node:vm');
const {selectedVersion,modelFlowSdk,hookBridge,fixtures}=require('./model-flow-sdk-fixtures.cjs');
const version=selectedVersion(),sdk=modelFlowSdk(version),{modules}=sdk.spec;
const setup=sdk.patched(modules.setup),outer=sdk.patched(modules.outer),embedded=sdk.patched(modules.embedded),hooks=sdk.patched(modules.hooks);
// The plugin's version table names the module that exports the contract; it is the one carrying the setup functions.
assert.equal(sdk.contract.module,'dist/'+modules.setup,'openclawSdkVersions.ts contract module is the patched setup module');
assert.equal(sdk.contract.symbol,'MODEL_PROFILE_CONTRACT_VERSION');
assert.match(setup,/\bMODEL_PROFILE_CONTRACT_VERSION = 1;/);assert.ok(/export const MODEL_PROFILE_CONTRACT_VERSION\b/.test(setup)||/\nexport \{[^}]*\bMODEL_PROFILE_CONTRACT_VERSION\b/.test(setup),'contract symbol exported');
assert.equal(sdk.original(modules.setup).includes('MODEL_PROFILE_CONTRACT_VERSION'),false,'unpatched module exports no contract (version 0, refused)');
const bridge=hookBridge(sdk);
const clone=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 const settings={authProfileId:'openai:authored-account',authProfileIdSource:'user',thinkLevel:'ultra',fastMode:false,modelFallbacksOverride:Array.from({length:20},(_,i)=>'openai/authored-'+i),summaryModelOverride:null};
 assert.deepEqual(clone(bridge.readHookModelProfile(settings)),settings);
 for(const value of [{fastMode:'yes'},{thinkLevel:'invalid'},{authProfileId:'a\nb'},{modelFallbacksOverride:Array(21).fill('openai/model')},{modelSelectionRefused:'unknown'}])assert.throws(()=>bridge.readHookModelProfile(value));
 const noOldHook={hasHooks:()=>true,runBeforeModelResolve(){throw Error('historical interpreter must not be called at the settings stage');},runBeforeModelResolveForPlugin:async(plugin,event,ctx)=>{assert.equal(plugin,'openclaw-plugin-mobile-ui');assert.equal(event.prompt,'');assert.equal(event.modelProfileVersion,1);return{...settings,providerOverride:'openai',modelOverride:'authored-primary'};}};
 const selected=await bridge.resolveHookModelSelection({prompt:'',provider:'other',modelId:'initial',profilePluginId:'openclaw-plugin-mobile-ui',selectionStage:'before_candidates',hookRunner:noOldHook,hookContext:{}});assert.equal(selected.modelId,'authored-primary');
 const locked=await bridge.resolveHookModelSelection({prompt:'',provider:'locked-provider',modelId:'locked-model',modelSelectionLocked:true,profilePluginId:'openclaw-plugin-mobile-ui',selectionStage:'candidate',hookRunner:noOldHook,hookContext:{}});assert.equal(locked.modelId,'locked-model');assert.equal(locked.provider,'locked-provider');assert.equal(locked.thinkLevel,'ultra');
 const cfg={agents:{defaults:{thinkingDefault:'high',fastModeDefault:true,compaction:{model:'openai/new-summary',reserveTokens:12}},entries:{main:{thinkingDefault:'high',fastModeDefault:true,tools:{retain:true}}}},channels:{retain:true}},before=clone(cfg);
 const params={config:cfg,agentId:'main',authProfileId:'old',fastMode:true,thinkLevel:'high'};bridge.applyHookModelProfile(params,{authProfileId:null,authProfileIdSource:null,thinkLevel:null,fastMode:null,modelFallbacksOverride:[],summaryModelOverride:null});assert.equal(params.authProfileId,undefined);assert.equal(params.thinkLevel,undefined);assert.equal(params.fastMode,undefined);assert.deepEqual(clone(params.modelFallbacksOverride),[]);assert.equal(params.config.agents.defaults.compaction.model,undefined);assert.equal(params.config.agents.defaults.compaction.reserveTokens,12);assert.equal(params.config.agents.entries.main.thinkingDefault,undefined);assert.deepEqual(cfg,before,'per-run settings projection never mutates global config');
 const start=outer.indexOf('async function runEmbeddedAgentEntryInternal(params) {')+'async function runEmbeddedAgentEntryInternal(params) {'.length,end=outer.indexOf(sdk.spec.outerEnd,start);assert.ok(start>100&&end>start);const prefix=outer.slice(start,end);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const prepare=new AsyncFunction('params','getGlobalHookRunner','resolveHookModelSelection',prefix+'\nreturn params;');
 let release;const pending=new Promise(r=>release=r);let prepared=false,checks=0;
 const owner={...noOldHook,runBeforeModelResolveForPlugin:async(...args)=>{await pending;return noOldHook.runBeforeModelResolveForPlugin(...args);}};
 const result=prepare({identity:{runId:'authored-run',agentId:'main',sessionId:'authored-session'},harness:{sessionKey:'agent:main:authored',workspaceDir:'/authored/workspace'},selection:{provider:'initial',model:'initial',fallbacksOverride:['initial/old']},preparedRunAdmission:{assertSourceCurrent(){checks++;}}},()=>owner,bridge.resolveHookModelSelection).then(value=>{prepared=true;return value;});await Promise.resolve();await Promise.resolve();assert.equal(prepared,false,'candidate planning waits for the native owner hook');release();const preparedParams=await result;assert.equal(checks,2,'source admission is checked again after awaiting settings');assert.equal(preparedParams.selection.model,'authored-primary');assert.deepEqual(clone(preparedParams.selection.fallbacksOverride),settings.modelFallbacksOverride);assert.equal(preparedParams.selection.userLockedAuthProfileId,settings.authProfileId);
 const runGeneration=embedded.indexOf('const runGeneration = async () => {');assert.ok(runGeneration>0);assert.ok(embedded.indexOf('selectionStage: "before_runtime"',runGeneration)<embedded.indexOf('runEmbeddedAgentViaCliBackendIfEligible({',runGeneration));
 const modelSetup=embedded.indexOf('applyHookModelProfile(runParams, hookSelection)');assert.ok(modelSetup>0);const authConsumer=embedded.indexOf('authProfileId:',modelSetup);assert.ok(authConsumer>modelSetup,'settings assigned to native runParams before auth preparation');
 const mergeStart=hooks.indexOf('const mergeBeforeModelResolve ='),mergeEnd=hooks.indexOf('\n\tconst ',mergeStart+10);assert.ok(mergeStart>0);const merge=vm.runInNewContext(hooks.slice(mergeStart,mergeEnd)+'\nmergeBeforeModelResolve',{firstDefined:(a,b)=>a===undefined?b:a});const combined=merge({fastMode:false,thinkLevel:null,modelFallbacksOverride:[]},{fastMode:true,thinkLevel:'high',modelFallbacksOverride:['openai/future']});assert.equal(combined.fastMode,false);assert.equal(combined.thinkLevel,null);assert.deepEqual(clone(combined.modelFallbacksOverride),[],'explicit clearing stays authoritative through existing hook merge');
 if(version==='2026.10.9'){
  // Type pins: the same three declarations as the 2026.9.6 capture, now in one chunk, applied with exact SHA.
  const pins=require(fixtures+'/s24-2026-10-25-model-flow-sdk/type-contract-pins.json');
  const types=sdk.patched(modules.types);
  for(const file of pins.files)assert.deepEqual(sdk.entry(modules.types).replacements,file.replacements,'2026.10.9 type pin identical to 2026.9.6 '+file.path);
  for(const [,after] of sdk.entry(modules.types).replacements)assert.equal(types.split(after).length,2);
  // Claim admission (new upstream guard): a revoked caller stops before the hook, or before the settings are used.
  const CLAIM=Symbol.for('openclaw.claimingHookAdmission');let live=true,calls=0;
  const admission={assertCurrent(){if(!live)throw Error('authored claim revoked');}};
  const revoking={...noOldHook,runBeforeModelResolveForPlugin:async(...args)=>{calls++;live=false;return noOldHook.runBeforeModelResolveForPlugin(...args);}};
  await assert.rejects(bridge.resolveHookModelSelection({prompt:'',provider:'p',modelId:'m',profilePluginId:'openclaw-plugin-mobile-ui',selectionStage:'before_candidates',hookRunner:revoking,hookContext:{[CLAIM]:admission}}),/authored claim revoked/);assert.equal(calls,1,'revocation during the awaited hook discards its settings');
  await assert.rejects(bridge.resolveHookModelSelection({prompt:'',provider:'p',modelId:'m',profilePluginId:'openclaw-plugin-mobile-ui',selectionStage:'before_candidates',hookRunner:revoking,hookContext:{[CLAIM]:admission}}),/authored claim revoked/);assert.equal(calls,1,'revoked caller never reaches the hook');
  live=true;const admitted=await bridge.resolveHookModelSelection({prompt:'',provider:'p',modelId:'m',profilePluginId:'openclaw-plugin-mobile-ui',selectionStage:'before_candidates',hookRunner:noOldHook,hookContext:{[CLAIM]:admission}});assert.equal(admitted.modelId,'authored-primary');assert.equal(admitted.thinkLevel,'ultra');
 }
 console.log(`Model SDK setup PASS (OpenClaw ${version}): actual hashed functions and awaited outer prefix; contract module of the version table; scoped owner, full settings, lock precedence,20 fallbacks, max/ultra, clearing, immutable config, account before native auth${version==='2026.10.9'?'; identical type pins; claim admission before and after the hook':''}. No native model request.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
