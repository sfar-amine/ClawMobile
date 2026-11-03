'use strict';
// S24 30/10 run_1793395301758: « Quel est l'état de mes factures » found samantha_utility_billing hidden behind
// OpenClaw Tool Search, failed a batched tool_search (batch-level limit) and read the bills through the shell.
// Runs the exact public SDK 2026.9.6 functions (byte-identical to the S24 module) with inert dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const guard = require('../dist/capabilityAgentGuard.js');
const typed = require('../dist/typedCapabilityTools.js');

const here = path.join(__dirname, '../fixtures/s24-2026-10-30-tool-search-direct');
const provenance = JSON.parse(fs.readFileSync(path.join(here, 'provenance.json'), 'utf8'));
const capture = JSON.parse(fs.readFileSync(path.join(here, 'brain-run-tool-sequence.json'), 'utf8'));
const source = zlib.gunzipSync(fs.readFileSync(path.join(here, 'local-model-lean-CHSAjCEl.mjs.gz'))).toString('utf8');
const sdkModule = provenance.modules[0];
assert.equal(crypto.createHash('sha256').update(source).digest("hex"), sdkModule.sha256);
assert.equal(sdkModule.sha256, sdkModule.s24Sha256, 'fixture must stay the exact S24 module');

function regionNamed(name) {
  const start = source.indexOf(`//#region ${name}\n`);
  assert(start >= 0, name);
  const end = source.indexOf('\n//#endregion', start);
  return source.slice(start, end);
}
const toolSearchRegion = regionNamed('src/agents/tool-search.ts');
const applyStart = toolSearchRegion.indexOf('function shouldExposeControlTool(');
const applyEnd = toolSearchRegion.indexOf('/** Move client-provided tools');
assert(applyStart > 0 && applyEnd > applyStart);

class ToolInputError extends Error {}
const pluginToolNames = new Set();
const sandbox = {
  ToolInputError, Map, Set, WeakMap, Array, Object, Number, JSON, TextEncoder, Math, String,
  isRecord: (value) => !!value && typeof value === 'object' && !Array.isArray(value),
  asToolParamsRecord: (value) => value && typeof value === 'object' ? value : {},
  Guard: {IsMaxLength: (value, max) => [...value].length <= max},
  stableStringify: (value) => JSON.stringify(value),
  normalizeStringEntries: (values) => values.map((value) => String(value).trim()).filter(Boolean),
  generateSecureHex: () => 'fixture',
  finalizeAgentToolAvailability: () => {},
  disposeCodeModeResults: () => {},
  // Plugin tools carry plugin meta; core read/exec/progress_card do not.
  getPluginToolMeta: (tool) => pluginToolNames.has(tool.name) ? {pluginId: 'openclaw-plugin-mobile-ui'} : undefined,
  isToolWrappedWithBeforeToolCallHook: () => true,
  wrapToolWithBeforeToolCallHook: (tool) => tool,
  rewrapToolWithBeforeToolCallHook: (tool) => tool,
  getBeforeToolCallDiagnosticOptions: () => undefined,
  isCoreCodingSurfaceToolName: (name) => ['read', 'write', 'edit', 'exec', 'process'].includes(name),
  resolveNodeRuntimeExecutable: () => undefined,
  process: {versions: {}},
};
vm.createContext(sandbox);
vm.runInContext([regionNamed('src/agents/tool-search-types.ts'), regionNamed('src/agents/tool-search-catalog.ts'),
  regionNamed('src/agents/tool-search-request.ts'), regionNamed('src/agents/tool-search-config.ts'),
  toolSearchRegion.slice(applyStart, applyEnd)].join('\n'), sandbox, {filename: 'local-model-lean-CHSAjCEl.mjs'});

// 1. Root cause of the lost turn: the batch-level limit is refused by the SDK request parser.
const config = sandbox.resolveToolSearchConfig(undefined);
assert.equal(config.mode, capture.toolSearchConfig.includes('"tools"') ? 'tools' : config.mode);
const failed = capture.calls.find((call) => call.tool === 'tool_search');
assert.throws(() => sandbox.readToolSearchRequest(failed.arguments, config), (error) => error.message === failed.error);
const fixed = {queries: failed.arguments.queries.map((entry) => ({...entry, limit: failed.arguments.limit}))};
assert.equal(sandbox.readToolSearchRequest(fixed, config).kind, 'batch');
assert.deepEqual(capture.calls.map((call) => call.tool), ['read', 'tool_search', 'exec']);

// 2. The captured S24 typed catalogue, through the SDK owner.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-direct-'));
const views = path.join(home, '.openclaw/capability-views');
fs.mkdirSync(views, {recursive: true});
fs.copyFileSync(path.join(__dirname, '../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json'), path.join(views, 'agent-tools.json'));
const helper = path.join(home, 'helper.py');
const helperLog = path.join(home, 'helper-calls.jsonl');
fs.writeFileSync(helper, `import sys,json\np=json.load(sys.stdin)\nopen(${JSON.stringify(helperLog)},'a').write(json.dumps(p['command'])+'\\n')\nprint(json.dumps({'state':'COMPLETED','received':p['command']}))\n`);
const ctx = {senderIsOwner: true, agentId: 'main', sessionKey: 'agent:main:companion-chat-direct', sessionId: 'session-direct',
  assertInvocationCurrent() {}};
const descriptors = typed.createTypedCapabilityTools(ctx, {home, helperPath: helper});
const names = descriptors.map((tool) => tool.name);
assert.deepEqual(names.filter((name) => name !== 'samantha_catalogue').sort(), [...capture.typedToolNamesOnS24.names].sort(),
  'fixture tool names equal the S24 projection of 30/10');
for (const name of names) pluginToolNames.add(name);
assert(typed.DIRECT_TYPED_TOOLS.has('samantha_utility_billing'));
// samantha_device_assistance (31/10) exists once its playbooks are activated: test-typed-device-direct.cjs covers it.
const pendingActivation = new Set(['samantha_device_assistance']);
const directInCapture = [...typed.DIRECT_TYPED_TOOLS].filter((name) => !pendingActivation.has(name));
for (const name of directInCapture) assert(names.includes(name), `${name} exists in the projection`);
for (const tool of descriptors)
  assert.equal(tool.catalogMode, typed.DIRECT_TYPED_TOOLS.has(tool.name) ? 'direct-only' : undefined, tool.name);

// The SDK plugin wrapper is a Proxy and before_tool_call spreads it ({...tool}): catalogMode must survive both.
function sdkWrapped(tool) {
  const proxy = new Proxy(Object.create(Object.getPrototypeOf(tool)), {
    get: (target, key) => Object.hasOwn(target, key) ? target[key] : Reflect.get(tool, key, tool),
    has: (target, key) => Reflect.has(target, key) || Reflect.has(tool, key),
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(tool), ...Reflect.ownKeys(target)])],
    getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key) ||
      (Reflect.getOwnPropertyDescriptor(tool, key) && {...Reflect.getOwnPropertyDescriptor(tool, key), configurable: true}),
  });
  return {...proxy};
}
const core = ['read', 'exec', 'progress_card'].map((name) => ({name, description: name, parameters: {type: 'object'}, execute() {}}));
const controls = ['tool_search', 'tool_describe', 'tool_call'].map((name) => ({name, description: name, parameters: {type: 'object'}, execute() {}}));
function surface(tools) {
  const catalogRef = {};
  const result = sandbox.applyToolSearchCatalog({tools: [...controls, ...core, ...tools], config: undefined, catalogRef, directToolNames: []});
  // Host-realm arrays: the SDK functions run in a vm context.
  return {visible: Array.from(result.tools, (tool) => tool.name),
    cataloged: Array.from(catalogRef.current.entries).filter((entry) => !entry.directVisible).map((entry) => entry.name)};
}
// Before (runtime main): every typed tool is hidden behind tool_search, as on the S24.
const before = surface(descriptors.map((tool) => { const {catalogMode, ...rest} = tool; return sdkWrapped(rest); }));
assert(!before.visible.includes('samantha_utility_billing'));
assert(before.cataloged.includes('samantha_utility_billing'));
assert.deepEqual(before.visible.sort(), ['exec', 'read', 'tool_call', 'tool_describe', 'tool_search']);
// After: the frequent owners are model-visible and outside the catalog; the others stay searchable.
const after = surface(descriptors.map(sdkWrapped));
for (const name of directInCapture) {
  assert(after.visible.includes(name), `${name} visible`);
  assert(!after.cataloged.includes(name), `${name} not cataloged`);
}
for (const name of ['samantha_laptop_s24_termux', 'samantha_tunisie_telecom', 'samantha_whatsapp', 'samantha_zain_bahrain', 'samantha_app'])
  assert(after.cataloged.includes(name) && !after.visible.includes(name), `${name} stays behind tool_search`);
assert(after.visible.includes('tool_search') && after.cataloged.includes('progress_card'));

// Prompt budget of the direct surface (schema + description, characters).
const directChars = descriptors.filter((tool) => typed.DIRECT_TYPED_TOOLS.has(tool.name))
  .reduce((total, tool) => total + tool.description.length + JSON.stringify(tool.parameters).length, 0);
// 30000 until 31/10; the device owner (one schema per closed parameter shape) adds about 3 000.
assert(directChars <= 32000, `direct typed surface ${directChars} chars`);

// 3. A billing question now needs exactly one typed tool call, the first business call of the turn.
(async () => {
  const billing = descriptors.find((tool) => tool.name === 'samantha_utility_billing');
  assert.match(billing.description, /état de mes factures/);
  const args = {action: 'billing.unpaid', params: {}};
  assert.equal(guard.agentCapabilityHook({toolName: billing.name, params: args, toolCallId: 'bill-1'},
    {requester: {senderIsOwner: true}, agentId: 'main', runId: 'user-run-bill', sessionKey: ctx.sessionKey, sessionId: ctx.sessionId}).block, undefined);
  const result = JSON.parse((await billing.execute('bill-1', args)).content[0].text);
  assert.equal(result.state, 'COMPLETED');
  assert.deepEqual(result.received, {operation: 'call', domain: 'utility-billing', action: 'billing.unpaid', params: {}});
  assert.equal(fs.readFileSync(helperLog, 'utf8').trim().split('\n').length, 1, 'one typed owner invocation');
  fs.rmSync(home, {recursive: true, force: true});
  console.log(JSON.stringify({ok: true, before: {visibleTyped: 0, cataloged: before.cataloged.length},
    after: {visibleTyped: [...typed.DIRECT_TYPED_TOOLS].length, cataloged: after.cataloged.length, directChars}, typedCallsForBillingQuestion: 1}));
})().catch((error) => { console.error(error); process.exit(1); });
