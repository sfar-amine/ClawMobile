'use strict';
// Execute the exact captured resolver functions with inert dependency owners.
// No SDK package import, auth access, network, model, device or runtime mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.argv[2];
assert(root, 'fixture root required');
function region(file, name) {
  const text = fs.readFileSync(path.join(root, 'dist', file), 'utf8');
  let start = text.indexOf(`function ${name}(`);
  assert(start >= 0);
  if (text.slice(start - 6, start) === 'async ') start -= 6;
  const end = text.indexOf('\n//#endregion', start);
  assert(end > start);
  return text.slice(start, end);
}
const staged = fs.readFileSync(path.join(root, 'dist/tools-CvXdkvXK.mjs'), 'utf8').includes('plugin-tools:load-state');
function outer(callback, authStore = true) {
  const events = [];
  const config = {};
  const fixtureTool = {name: 'fixture'};
  const sandbox = {
    Set,
    resolveAgentRuntimeToolConfig: () => {events.push('config'); return config;},
    getRuntimeConfigSnapshot: () => config,
    resolveOpenClawPluginToolInputs: () => {events.push('inputs'); return {context: {senderIsOwner: true}};},
    bindRequesterOwnerIdentity: () => {throw Error('must not change owner branch');},
    createPluginToolDelivery: () => {events.push('delivery');},
    createRuntimeProviderAuthLookup: () => {events.push('auth'); return {};},
    getPluginRuntimeGatewayRequestScope: () => undefined,
    getActivePluginRegistry: () => undefined,
    getPluginRuntimeLoadContext: () => undefined,
    captureGatewayToolCallerAssertion: () => undefined,
    resolvePluginTools: (params) => {
      events.push('resolve');
      assert.equal(params.recordToolPrepStage, staged ? callback : undefined);
      return [fixtureTool];
    },
    createNodePluginTools: () => {events.push('nodes'); return [];},
  };
  vm.createContext(sandbox);
  vm.runInContext(region('openclaw-tools-thu-J91q.mjs', 'resolveOpenClawPluginToolsForOptions'), sandbox);
  const result = sandbox.resolveOpenClawPluginToolsForOptions({options: {
    ...(authStore ? {authProfileStore: {}} : {}),
    ...(callback ? {recordToolPrepStage: callback} : {}),
  }});
  assert.equal(result.length, 1);
  assert.equal(result[0], fixtureTool);
  assert.deepEqual(events, authStore ? ['config', 'inputs', 'delivery', 'auth', 'resolve', 'nodes'] :
                                    ['config', 'inputs', 'delivery', 'resolve', 'nodes']);
}
const outerStages = [];
outer((name) => outerStages.push(name));
outer(undefined);
outer(undefined, false);
assert.deepEqual(outerStages, staged ? ['plugin-tools:input-context', 'plugin-tools:delivery-context',
  'plugin-tools:auth-lookup', 'plugin-tools:prepared-context', 'plugin-tools:resolved'] : []);

function inner({loaded, fail = false, noState = false, callback = true}) {
  const stages = [];
  const effects = [];
  const context = {config: {}, logger: {error: () => {throw Error('unexpected error log');}}};
  const runtimeRegistry = {plugins: [{id: 'fixture'}], tools: []};
  const loadState = {context, env: {}, onlyPluginIds: ['fixture'], allowlist: {},
    snapshot: {plugins: [], byPluginId: new Map()}, loadOptions: {manifestRegistry: {plugins: []}}};
  const sandbox = {
    Set, Map, Array,
    resolvePluginToolLoadState: () => {effects.push('load-state'); return noState ? undefined : loadState;},
    normalizeToolPolicyName: (name) => name,
    normalizeDenylist: () => [],
    inspectionToolOwners: new WeakMap(),
    createRuntimePluginManifestLookup: () => {effects.push('lookup'); return () => ({id: 'fixture'});},
    getPluginInstance: () => {effects.push('instance'); return {toolRegistrationComplete: loaded};},
    samePluginToolSource: () => false,
    loadPluginRegistryHandle: () => {
      effects.push('load-registry');
      if (fail) throw Error('fixture loader failure');
      return runtimeRegistry;
    },
    createPluginToolFactoryResolver: () => ({report: () => effects.push('factory-report')}),
  };
  vm.createContext(sandbox);
  vm.runInContext(region('tools-CvXdkvXK.mjs', 'resolvePluginTools'), sandbox);
  const params = {context, runtimeRegistry, ...(callback ? {recordToolPrepStage: (name) => stages.push(name)} : {})};
  if (fail) assert.throws(() => sandbox.resolvePluginTools(params), /fixture loader failure/);
  else assert.equal(sandbox.resolvePluginTools(params).length, 0);
  if (noState) {
    assert.deepEqual(effects, ['load-state']);
    assert.deepEqual(stages, staged && callback ? ['plugin-tools:load-state'] : []);
    return;
  }
  assert.deepEqual(effects, ['load-state', 'lookup', 'instance',
    ...(!loaded ? ['load-registry'] : []), ...(!fail ? ['factory-report'] : [])]);
  assert.deepEqual(stages, staged && callback ? ['plugin-tools:load-state', 'plugin-tools:registry-context',
    'plugin-tools:runtime-owners', ...(!fail ? [loaded ? 'plugin-tools:registry-reused' : 'plugin-tools:registry-loaded',
      'plugin-tools:registrations', 'plugin-tools:factories'] : [])] : []);
}
inner({loaded: true});
inner({loaded: false});
inner({loaded: false, fail: true});
inner({loaded: true, noState: true});
inner({loaded: true, callback: false});
inner({loaded: false, callback: false});

async function systemPrompt({failRuntime = false, settled = false} = {}) {
  let clock = 0;
  const effects = [];
  const step = (name, ms, result) => (...args) => {effects.push(name); clock += ms; return result;};
  const sandbox = {
    Set, Promise,
    // Exact function arguments evaluate env/argv before invoking inert owners.
    // Never expose the host process, environment, cwd, credentials or commands.
    process: Object.freeze({env: Object.freeze({}),
      argv: Object.freeze(['fixture-node', '/fixture/public-sdk.mjs'])}),
    resolveEmbeddedSandboxInfoExecPolicy: step('policy', 1, {}),
    buildEmbeddedSandboxInfo: step('sandbox', 1, {enabled: false}),
    isReasoningTagProvider: step('reasoning', 2, false),
    buildToolSchemaDirectoryPrompt: step('tool-directory', 4, undefined),
    resolveAgentRuntimePrompt: async () => {
      effects.push('runtime-context'); clock += 11;
      if (failRuntime) throw Error('fixture runtime failure');
      return {runtimeInfo: {agentId: 'main', sessionKey: 'fixture'}};
    },
    resolveAgentPromptSurfaceForSessionKey: () => 'full',
    toolPolicyRestrictsTools: () => false,
    resolveOpenClawReferencePaths: step('references', 7, {}),
    resolveProviderSystemPromptContribution: step('provider-contribution', 3, undefined),
    prepareAgentMemoryPrompt: step('memory', 9, undefined),
    prepareWatchedSessionsPrompt: step('watched', 2, undefined),
    prepareProjectMemoryBootstrap: step('project-memory', 5, []),
    buildProjectMemoryWriteInstruction: () => undefined,
    buildModelToolsUnavailablePrompt: () => undefined,
    isAcpRuntimeSpawnAvailable: () => false,
    listRegisteredPluginAgentPromptGuidance: () => [],
    buildBootstrapPromptWarningNotice: () => undefined,
    buildAttemptSystemPrompt: step('assembly', 13, {systemPrompt: 'fixture-system'}),
    buildBootstrapTruncationReportMeta: () => ({}),
    resolveSandboxRuntimeStatus: () => ({mode: 'off', sandboxed: false}),
    buildSystemPromptReport: step('report', 17, {ok: true}),
  };
  vm.createContext(sandbox);
  const trackerSource = fs.readFileSync(path.join(__dirname,
    '../../openclaw-plugin-mobile-ui/fixtures/s24-2026-10-26-gateway-prep-stages/stage-timing-BUG4Fnsv.mjs'), 'utf8');
  vm.runInContext(trackerSource.slice(0, trackerSource.indexOf('\n//#endregion')), sandbox);
  const tracker = sandbox.createStageTimingTracker(() => clock);
  tracker.mark('tool-preparation');
  // Only import.meta.url is replaced by an inert public module URL for vm.Script;
  // the original and patched function bodies otherwise run unchanged. A separate
  // Node --check parses each full real ESM module with its original import.meta.
  vm.runInContext(region('builtin-openclaw-q1hiFm14.mjs', 'prepareEmbeddedAttemptSystemPrompt')
    .replaceAll('import.meta.url', JSON.stringify('file:///fixture/public-sdk.mjs')), sandbox);
  const params = {
    attempt: {operation: settled ? 'settled-tool-finalization' : undefined,
      provider: 'fixture', modelId: 'fixture', model: {api: 'fixture'}, config: {},
      sessionKey: 'fixture', promptMode: 'full', preparedModelRuntime: {
        activeProjectKeys: ['fixture'], projectKey: 'fixture'}},
    setup: {sessionAgentId: 'main', sandboxSessionKey: 'fixture',
      effectiveWorkspace: '/fixture', effectiveCwd: '/fixture',
      getProviderRuntimeHandle: () => ({}), prepStages: tracker},
    effectiveTools: [], capabilityToolNames: [], toolSearchDirectoryEnabled: true,
    toolSearchCatalogRef: {current: {entries: [{}]}}, toolSearchRuntimeConfig: {},
    bootstrap: {workspaceNotes: [], contextFiles: [], bootstrapInjectionStats: [],
      bootstrapPromptWarning: {lines: []}}, modelToolsEnabled: true,
  };
  if (failRuntime) {
    await assert.rejects(() => sandbox.prepareEmbeddedAttemptSystemPrompt(params), /fixture runtime failure/);
    assert(!tracker.snapshot().stages.some((entry) => entry.name === 'system-prompt'));
    assert.deepEqual(effects, ['policy', 'sandbox', 'reasoning', 'tool-directory', 'runtime-context']);
    return;
  }
  const result = await sandbox.prepareEmbeddedAttemptSystemPrompt(params);
  const stages = Array.from(tracker.snapshot().stages);
  const parent = stages.find((entry) => entry.name === 'system-prompt');
  assert(parent, 'aggregate parent must still exist');
  if (settled) {
    assert.equal(result.systemPromptText, '');
    assert.equal(parent.durationMs, 0);
    assert.equal(stages.length, 2);
    assert.deepEqual(effects, []);
    return;
  }
  assert.equal(result.systemPromptText, 'fixture-system');
  assert.equal(JSON.stringify(result.systemPromptReport), '{"ok":true}');
  assert.deepEqual(effects, ['policy', 'sandbox', 'reasoning', 'tool-directory', 'runtime-context',
    'references', 'provider-contribution', 'memory', 'watched', 'project-memory', 'assembly', 'report']);
  assert.equal(parent.durationMs, 75, 'explicit spans must NOT advance parent checkpoint');
  assert.equal(parent.elapsedMs, 75);
  assert.equal(tracker.snapshot().totalMs, 75);
  const children = stages.filter((entry) => entry.name.startsWith('system-prompt:'));
  assert.deepEqual(children.map((entry) => [entry.name, entry.durationMs]), staged ? [
    ['system-prompt:tool-directory', 4], ['system-prompt:runtime-context', 11],
    ['system-prompt:references', 7], ['system-prompt:provider-contribution', 3],
    ['system-prompt:memory-context', 11], ['system-prompt:project-memory', 5],
    ['system-prompt:assembly', 13], ['system-prompt:report', 17]] : []);
}

(async () => {
  await systemPrompt();
  await systemPrompt({failRuntime: true});
  await systemPrompt({settled: true});
  console.log(JSON.stringify({ok: true, staged, scopes: 12, modelCalls: 0, authReads: 0}));
})().catch((error) => {console.error(error); process.exitCode = 1;});
