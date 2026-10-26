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
  const start = text.indexOf(`function ${name}(`);
  assert(start >= 0);
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
console.log(JSON.stringify({ok: true, staged, scopes: 9, modelCalls: 0, authReads: 0}));
