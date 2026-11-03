// Session summary (compaction) profile on the actual hashed SDK functions, per pinned OpenClaw version:
//   node test-model-flow-compaction.cjs            -> 2026.9.6 (S24 production capture, unchanged)
//   node test-model-flow-compaction.cjs 2026.10.9  -> upgrade candidate (public npm modules)
const assert=require('node:assert/strict'),vm=require('node:vm');
const {selectedVersion,modelFlowSdk,hookBridge,region}=require('./model-flow-sdk-fixtures.cjs');
const version=selectedVersion(),sdk=modelFlowSdk(version),legacy=version==='2026.9.6';
const clone=value=>JSON.parse(JSON.stringify(value));
const compact=sdk.patched(sdk.spec.modules.compact),target=sdk.patched(sdk.spec.modules.target);
const bridge=hookBridge(sdk);
const preflight=vm.runInNewContext(region(compact,'function projectCodexHostTranscriptBytePreflightConfig(','/** Resolves the shared policy')+'\nprojectCodexHostTranscriptBytePreflightConfig');
const head='async function compactEmbeddedAgentSessionDirect(paramsInput) {';
const prefix=region(compact,head,'\tconst requestedAgentIds =').slice(head.length);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
// 2026.10.9 reads the entry through the async worker reader with a liveness check, and inherits the async work signal.
const portNames=legacy
 ?['applyAgentRunSessionTargetIdentity','readCompactionAccountingRecorder','resolveAgentRunSessionTarget','loadSessionEntryReadOnly','resolveSessionPinnedHarnessId','consumeTranscriptBytePreflightClaim','getGlobalHookRunner','resolveHookModelSelection','applyHookModelProfile','projectCodexHostTranscriptBytePreflightConfig','projectPublicSessionEntry']
 :['applyAgentRunSessionTargetIdentity','getAsyncWorkSignal','readCompactionAccountingRecorder','resolveAgentRunSessionTarget','readSessionEntryReadOnlyInWorker','resolveSessionPinnedHarnessId','consumeTranscriptBytePreflightClaim','getGlobalHookRunner','resolveHookModelSelection','applyHookModelProfile','projectCodexHostTranscriptBytePreflightConfig','projectPublicSessionEntry'];
const runPrefix=new AsyncFunction('paramsInput',...portNames,prefix+'\nreturn {requestedParams,projectSessionSummaryConfig};');
const cfg=()=>({agents:{defaults:{model:{primary:'openai/current-brain'},thinkingDefault:'low',fastModeDefault:true,compaction:{model:'openai/new-summary',provider:'legacy-unchanged',mode:'safeguard',reserveTokens:12000}},entries:{main:{identity:'retain',tools:{deny:['fixture']}}}},other:{retain:true}});
const identity={agentId:'main',sessionId:'native-session',sessionKey:'agent:main:companion-compact-fixture',storePath:'/authored/native/session-owner'};
let entryReads=0,hookCalls=0;
async function execute(options={}){
 const calls=[],entry={sessionId:identity.sessionId,...options.entry};
 const config=cfg();const before=clone(config);
 const runner={hasHooks:()=>true,runBeforeModelResolveForPlugin:async(id,event,context)=>{
  hookCalls++;calls.push({id,event,context});if(options.pending)await options.pending;
  if(options.reject)throw Error('authored unavailable profile');
  return options.selected??{summaryModelOverride:'openai/old-summary@openai:authored-summary',thinkLevel:'high',fastMode:false,modelOverride:'must-not-change-brain'};
 }};
 const ports={applyAgentRunSessionTargetIdentity:value=>value,getAsyncWorkSignal:()=>undefined,readCompactionAccountingRecorder:()=>null,resolveAgentRunSessionTarget:async()=>identity,
  loadSessionEntryReadOnly:()=>entry,
  readSessionEntryReadOnlyInWorker:async(scope,assertReadCurrent)=>{entryReads++;assert.equal(scope.readConsistency,'latest');assert.equal(scope.sessionKey,identity.sessionKey);assertReadCurrent();return entry;},
  resolveSessionPinnedHarnessId:()=>options.harness,consumeTranscriptBytePreflightClaim:()=>options.preflight?{authority:{id:'native-preflight'}}:undefined,
  getGlobalHookRunner:()=>options.noRunner?undefined:runner,resolveHookModelSelection:bridge.resolveHookModelSelection,applyHookModelProfile:bridge.applyHookModelProfile,
  projectCodexHostTranscriptBytePreflightConfig:preflight,projectPublicSessionEntry:clone};
 const result=await runPrefix({config,provider:'openai',model:'current-brain',workspaceDir:'/authored/workspace',...options.params},...portNames.map(name=>ports[name]));
 assert.deepEqual(config,before,'projection never mutates live config');return {result,calls,before};
}
(async()=>{
 const selected=await execute();assert.equal(selected.calls.length,1);
 assert.equal(selected.calls[0].id,'openclaw-plugin-mobile-ui');assert.equal(selected.calls[0].event.prompt,'');assert.equal(selected.calls[0].event.modelProfileVersion,1);assert.equal(selected.calls[0].event.modelProfileStage,'summary');
 assert.equal(selected.calls[0].context.sessionId,identity.sessionId);
 assert.equal(selected.result.requestedParams.config.agents.defaults.compaction.model,'openai/old-summary@openai:authored-summary');
 assert.equal(selected.result.requestedParams.model,'current-brain');assert.equal(selected.result.requestedParams.thinkLevel,undefined);assert.equal(selected.result.requestedParams.fastMode,undefined,'summary cannot smuggle effort/speed from hook');
 for(const replacement of ['admitted-config','prepared-snapshot-config']){
  const latest=cfg();latest.agents.defaults.compaction.model=replacement;
  const pinned=selected.result.projectSessionSummaryConfig(latest);
  assert.equal(pinned.agents.defaults.compaction.model,'openai/old-summary@openai:authored-summary');assert.equal(latest.agents.defaults.compaction.model,replacement);
  assert.equal(pinned.agents.defaults.compaction.mode,'safeguard');assert.equal(pinned.agents.defaults.fastModeDefault,true);
 }
 assert.ok(compact.includes('projectSessionSummaryConfig(admittedConfig)'));assert.ok(compact.includes('projectSessionSummaryConfig(preparedModelRuntimeOwnerSnapshot.config)'));
 const inherited=await execute({selected:{summaryModelOverride:null}});assert.equal(Object.hasOwn(inherited.result.requestedParams.config.agents.defaults.compaction,'model'),false);assert.equal(inherited.result.requestedParams.config.agents.defaults.compaction.provider,'legacy-unchanged');assert.equal(inherited.result.requestedParams.config.agents.defaults.compaction.reserveTokens,12000);
 const locked=await execute({entry:{modelSelectionLocked:true},harness:'locked-native'});assert.equal(locked.calls.length,0);assert.equal(locked.result.requestedParams.modelSelectionLocked,true);assert.deepEqual(locked.result.requestedParams.config,locked.before);
 const preflightCase=await execute({preflight:true,harness:'locked-native'});assert.equal(preflightCase.calls.length,0);assert.equal(Object.hasOwn(preflightCase.result.requestedParams.config.agents.defaults.compaction,'model'),false);assert.equal(Object.hasOwn(preflightCase.result.requestedParams.config.agents.defaults.compaction,'provider'),false);assert.equal(preflightCase.result.requestedParams.config.agents.defaults.compaction.reserveTokens,12000);
 const missing=await execute({noRunner:true});assert.equal(missing.calls.length,0);assert.deepEqual(missing.result.requestedParams.config,missing.before,'unregistered original SDK path keeps its original policy');
 await assert.rejects(execute({reject:true}),/Model profile selection failed/);
 await assert.rejects(execute({selected:{modelSelectionRefused:'unqualified'}}),/Model profile selection unavailable/);
 let release;const pending=new Promise(r=>release=r);let finished=false;const waiting=execute({pending}).then(value=>{finished=true;return value;});await Promise.resolve();await Promise.resolve();assert.equal(finished,false,'profile hook is awaited before runtime preparation');release();await waiting;
 if(!legacy){
  // Cancellation (new upstream guard): aborted before the entry read -> no hook; aborted during the hook -> no projection.
  assert.ok(entryReads>0,'2026.10.9 reads the entry through the worker reader');
  const early=new AbortController();early.abort();const beforeEarly=hookCalls;
  await assert.rejects(execute({params:{abortSignal:early.signal}}),/abort/i);assert.equal(hookCalls,beforeEarly,'aborted compaction never reaches the profile hook');
  const during=new AbortController();let resume;const hold=new Promise(r=>resume=r);
  const beforeDuring=hookCalls;const run=execute({params:{abortSignal:during.signal},pending:hold});for(let i=0;i<5&&hookCalls===beforeDuring;i++)await Promise.resolve();assert.equal(hookCalls,beforeDuring+1);during.abort();resume();
  await assert.rejects(run,/abort/i,'summary selection resolved after cancellation is not used');
 }
 const splitSource=sdk.modelRef();const splitter=vm.runInNewContext(region(splitSource,'function splitTrailingAuthProfile(','//#endregion')+'\nsplitTrailingAuthProfile');
 const targetFn=region(target,'function resolveEmbeddedCompactionTarget(','/** Binds harness ownership');
 const resolveTarget=vm.runInNewContext(targetFn+'\nresolveEmbeddedCompactionTarget',{splitTrailingAuthProfile:splitter,resolveCompactionTargetRuntime:()=>({}),hasBareConfiguredModelForProvider:()=>false,inferUniqueProviderFromConfiguredModels:()=>undefined,listModelAliasCandidates:()=>[],normalizeLowercaseStringOrEmpty:v=>String(v??'').trim().toLowerCase(),normalizeCompactionConfigKey:v=>String(v??'').trim().toLowerCase()});
 const base={provider:'openai',modelId:'current-brain',authProfileId:'openai:authored-brain',defaultProvider:'openai',defaultModel:'default'};
 const explicit=resolveTarget({...base,config:{agents:{defaults:{compaction:{model:'google/gemini-free@google:authored-free'}}}}});
 assert.equal(explicit.provider,'google');assert.equal(explicit.model,'gemini-free');assert.equal(explicit.authProfileId,'google:authored-free','native target consumes the explicit summary account rather than including it in model id');
 const same=resolveTarget({...base,config:{agents:{defaults:{compaction:{model:'openai/luna@openai:authored-summary'}}}}});assert.equal(same.model,'luna');assert.equal(same.authProfileId,'openai:authored-summary');
 const lockedTarget=resolveTarget({...base,modelSelectionLocked:true,config:{agents:{defaults:{compaction:{model:'google/other@google:authored-free'}}}}});assert.equal(lockedTarget.provider,'openai');assert.equal(lockedTarget.model,'current-brain');assert.equal(lockedTarget.authProfileId,base.authProfileId);
 const nullTarget=resolveTarget({...base,config:inherited.result.requestedParams.config});assert.equal(nullTarget.model,'current-brain','null summary keeps current conversation model, never global default');
 const providerOnly=resolveTarget({...base,config:{agents:{defaults:{compaction:{model:'google/gemini-free'}}}}});assert.equal(providerOnly.authProfileId,undefined,'without explicit account cross-provider never retains current private account');
 console.log(`Compaction SDK fixture PASS (OpenClaw ${version}): exact SHA replacements; awaited native prefix; model-only pin across refreshed configs; null inheritance; locked/native-preflight preservation; explicit account consumed without model suffix; refusal before preparation${legacy?'':'; cancellation before the hook and after it'}. No native S24 model call or patch.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
