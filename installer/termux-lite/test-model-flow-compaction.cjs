const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const path=require('node:path');
const root=path.resolve(__dirname,'../../openclaw-plugin-mobile-ui/fixtures/s24-2026-10-25-model-flow-sdk')+'/';
const descriptor=require('./openclaw-compat/model-flow-selection.json');
const proposed={files:['compact-lmmQAHsq.mjs','context-engine-maintenance-VqmqPz8h.mjs'].map(name=>descriptor.files.find(row=>row.path==='dist/'+name))};
const clone=value=>JSON.parse(JSON.stringify(value));
function apply(source,entry){
 assert.equal(crypto.createHash('sha256').update(source).digest('hex'),entry.original);
 for(const [before,after]of entry.replacements){assert.equal(source.split(before).length-1,1);source=source.replace(before,after);}
 assert.equal(crypto.createHash('sha256').update(source).digest('hex'),entry.patched);return source;
}
const compact=apply(fs.readFileSync(root+'compact-lmmQAHsq.mjs','utf8'),proposed.files[0]);
const target=apply(fs.readFileSync(root+'context-engine-maintenance-VqmqPz8h.mjs','utf8'),proposed.files[1]);
const setupManifest=descriptor.files.find(row=>row.path.endsWith('/setup-B7DuERIi.mjs'));
const setup=apply(fs.readFileSync(root+'setup-B7DuERIi.mjs','utf8'),setupManifest);
const setupFunctions=setup.slice(setup.indexOf('function readHookModelProfile('),setup.indexOf('/**\n* Converts prompt image refs'));
const applyProfile=setup.slice(setup.indexOf('function applyHookModelProfile('),setup.indexOf('//#endregion\nexport { applyHookModelProfile'));
assert.ok(setupFunctions.length>100&&applyProfile.length>100);
const bridge=vm.runInNewContext(setupFunctions+'\n'+applyProfile+'\n({resolveHookModelSelection,applyHookModelProfile})',{log:{info(){},warn(){}}});
const projectPreflight=compact.slice(compact.indexOf('function projectCodexHostTranscriptBytePreflightConfig('),compact.indexOf('/** Resolves the shared policy'));
const preflight=vm.runInNewContext(projectPreflight+'\nprojectCodexHostTranscriptBytePreflightConfig');
const prefixStart=compact.indexOf('async function compactEmbeddedAgentSessionDirect(paramsInput) {');
const prefixEnd=compact.indexOf('\tconst requestedAgentIds =',prefixStart);
const prefix=compact.slice(prefixStart+'async function compactEmbeddedAgentSessionDirect(paramsInput) {'.length,prefixEnd);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const runPrefix=new AsyncFunction('paramsInput','applyAgentRunSessionTargetIdentity','readCompactionAccountingRecorder','resolveAgentRunSessionTarget','loadSessionEntryReadOnly','resolveSessionPinnedHarnessId','consumeTranscriptBytePreflightClaim','getGlobalHookRunner','resolveHookModelSelection','applyHookModelProfile','projectCodexHostTranscriptBytePreflightConfig','projectPublicSessionEntry',prefix+'\nreturn {requestedParams,projectSessionSummaryConfig};');
const cfg=()=>({agents:{defaults:{model:{primary:'openai/current-brain'},thinkingDefault:'low',fastModeDefault:true,compaction:{model:'openai/new-summary',provider:'legacy-unchanged',mode:'safeguard',reserveTokens:12000}},entries:{main:{identity:'retain',tools:{deny:['fixture']}}}},other:{retain:true}});
const identity={agentId:'main',sessionId:'native-session',sessionKey:'agent:main:companion-compact-fixture',storePath:'/authored/native/session-owner'};
async function execute(options={}){
 const calls=[],entry={sessionId:identity.sessionId,...options.entry};
 const config=cfg();const before=clone(config);
 const runner={hasHooks:()=>true,runBeforeModelResolveForPlugin:async(id,event,context)=>{
  calls.push({id,event,context});if(options.pending)await options.pending;
  if(options.reject)throw Error('authored unavailable profile');
  return options.selected??{summaryModelOverride:'openai/old-summary@openai:authored-summary',thinkLevel:'high',fastMode:false,modelOverride:'must-not-change-brain'};
 }};
 const result=await runPrefix({config,provider:'openai',model:'current-brain',workspaceDir:'/authored/workspace',...options.params},
  value=>value,()=>null,async()=>identity,()=>entry,()=>options.harness,
  ()=>options.preflight?{authority:{id:'native-preflight'}}:undefined,
  ()=>options.noRunner?undefined:runner,bridge.resolveHookModelSelection,bridge.applyHookModelProfile,preflight,clone);
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
 const splitSource=fs.readFileSync(root+'model-ref-profile-BIKs-96s.mjs','utf8');const splitter=vm.runInNewContext(splitSource.slice(splitSource.indexOf('function splitTrailingAuthProfile('),splitSource.indexOf('//#endregion'))+'\nsplitTrailingAuthProfile');
 const targetFn=target.slice(target.indexOf('function resolveEmbeddedCompactionTarget('),target.indexOf('/** Binds harness ownership'));
 const resolveTarget=vm.runInNewContext(targetFn+'\nresolveEmbeddedCompactionTarget',{splitTrailingAuthProfile:splitter,resolveCompactionTargetRuntime:()=>({}),hasBareConfiguredModelForProvider:()=>false,inferUniqueProviderFromConfiguredModels:()=>undefined,listModelAliasCandidates:()=>[]});
 const base={provider:'openai',modelId:'current-brain',authProfileId:'openai:authored-brain',defaultProvider:'openai',defaultModel:'default'};
 const explicit=resolveTarget({...base,config:{agents:{defaults:{compaction:{model:'google/gemini-free@google:authored-free'}}}}});
 assert.equal(explicit.provider,'google');assert.equal(explicit.model,'gemini-free');assert.equal(explicit.authProfileId,'google:authored-free','native target consumes the explicit summary account rather than including it in model id');
 const same=resolveTarget({...base,config:{agents:{defaults:{compaction:{model:'openai/luna@openai:authored-summary'}}}}});assert.equal(same.model,'luna');assert.equal(same.authProfileId,'openai:authored-summary');
 const lockedTarget=resolveTarget({...base,modelSelectionLocked:true,config:{agents:{defaults:{compaction:{model:'google/other@google:authored-free'}}}}});assert.equal(lockedTarget.provider,'openai');assert.equal(lockedTarget.model,'current-brain');assert.equal(lockedTarget.authProfileId,base.authProfileId);
 const nullTarget=resolveTarget({...base,config:inherited.result.requestedParams.config});assert.equal(nullTarget.model,'current-brain','null summary keeps current conversation model, never global default');
 const providerOnly=resolveTarget({...base,config:{agents:{defaults:{compaction:{model:'google/gemini-free'}}}}});assert.equal(providerOnly.authProfileId,undefined,'without explicit account cross-provider never retains current private account');
 console.log('Compaction SDK fixture PASS: exact SHA replacements; awaited native prefix; model-only pin across refreshed configs; null inheritance; locked/native-preflight preservation; explicit account consumed without model suffix; refusal before preparation. No native S24 model call or patch.');
})().catch(error=>{console.error(error);process.exitCode=1;});
