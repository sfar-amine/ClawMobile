'use strict';
// S24 31/10: the brain had no typed phone tool and improvised with the shell (35 s for the torch). The playbooks
// projection now carries samantha_device_assistance; Amine decided that torch, Do Not Disturb, timer, alarm and a
// Settings page run directly (no recap), then are announced. This checks the plugin side with the public factory:
// direct-only visibility, no confirmation marker on those five, one typed owner invocation per call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../dist/capabilityAgentGuard.js');
const typed = require('../dist/typedCapabilityTools.js');

const s24 = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json'), 'utf8'));
const device = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/playbooks-2026-10-31-device-typed-tool/device-assistance-tool.json'), 'utf8'));
assert.equal(device.tool.name, 'samantha_device_assistance');
assert.equal(device.source.repository, 'sfar-amine/samantha-ui-playbooks');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-device-'));
const views = path.join(home, '.openclaw/capability-views');
fs.mkdirSync(views, {recursive: true});
// The compiled view as activation will write it: the S24 capture plus the new owner (still under 32 tools).
fs.writeFileSync(path.join(views, 'agent-tools.json'), JSON.stringify({...s24, tools: [...s24.tools, device.tool]}));
assert.equal(typed.readTypedToolCatalogue(home).length, s24.tools.length + 1, 'catalogue validator accepts the device owner');

const helper = path.join(home, 'helper.py');
const helperLog = path.join(home, 'helper-calls.jsonl');
fs.writeFileSync(helper, `import sys,json\np=json.load(sys.stdin)\nopen(${JSON.stringify(helperLog)},'a').write(json.dumps(p['command'])+'\\n')\n` +
  `print(json.dumps({'state':'COMPLETED','answer':'Torche allumée.','facts':{'on':True}}))\n`);
const ctx = {senderIsOwner: true, agentId: 'main', sessionKey: 'agent:main:companion-chat-device', sessionId: 'session-device',
  assertInvocationCurrent() {}};
const descriptors = typed.createTypedCapabilityTools(ctx, {home, helperPath: helper});
const tool = descriptors.find((entry) => entry.name === 'samantha_device_assistance');
assert(tool, 'device tool exposed to the owner');
assert.equal(tool.catalogMode, 'direct-only');
assert(typed.DIRECT_TYPED_TOOLS.has('samantha_device_assistance'));
// S24 31/10 15:20: the Gateway refuses a plugin tool absent from contracts.tools (« plugin must declare
// contracts.tools for: samantha_device_assistance »), and the typed factory's whole batch went with it: the brain
// lost samantha_agenda and improvised through the shell. Every typed owner the factory can return is declared.
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../openclaw.plugin.json'), 'utf8'));
for (const name of [...typed.DIRECT_TYPED_TOOLS, ...descriptors.map((entry) => entry.name)])
  assert(manifest.contracts.tools.includes(name), `${name} declared in openclaw.plugin.json contracts.tools`);

const direct = ['device.torch.set', 'device.dnd.set', 'device.timer.start', 'device.alarm.set', 'device.settings.open'];
const lines = tool.description.split('\n');
for (const action of direct) {
  const line = lines.find((entry) => entry.startsWith(action + ':'));
  assert(line, action);
  assert(!line.includes('récapitulatif puis confirmation'), `${action} runs directly`);
}
assert.match(tool.description, /les autres s'exécutent directement/);
assert.match(tool.description, /« récapitulatif puis confirmation » exigent un nouveau tour utilisateur/);
assert.deepEqual(tool.parameters.properties.action.enum.filter((name) => name.startsWith('device.')).sort(),
  device.tool.actions.map((action) => action.action).sort());
// A non-owner never sees the factory.
assert.equal(typed.createTypedCapabilityTools({...ctx, senderIsOwner: false}, {home, helperPath: helper}), null);

// Prompt budget of the whole direct surface with the device owner (schema + description, characters).
const directChars = descriptors.filter((entry) => typed.DIRECT_TYPED_TOOLS.has(entry.name))
  .reduce((total, entry) => total + entry.description.length + JSON.stringify(entry.parameters).length, 0);
// 30000 until 31/10; the device owner (one schema per closed parameter shape) adds about 3 000.
assert(directChars <= 32000, `direct typed surface ${directChars} chars`);

(async () => {
  const args = {action: 'device.torch.set', params: {on: true}};
  // The host hook binds the call to the owner's current run, as the SDK does before execute.
  assert.equal(guard.agentCapabilityHook({toolName: tool.name, params: args, toolCallId: 'torch-1'},
    {requester: {senderIsOwner: true}, agentId: 'main', runId: 'user-run-torch', sessionKey: ctx.sessionKey, sessionId: ctx.sessionId}).block, undefined);
  const result = JSON.parse((await tool.execute('torch-1', args)).content[0].text);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.answer, 'Torche allumée.');
  const calls = fs.readFileSync(helperLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls, [{operation: 'call', domain: 'device-assistance', action: 'device.torch.set', params: {on: true}}]);
  fs.rmSync(home, {recursive: true, force: true});
  console.log(JSON.stringify({ok: true, deviceActions: device.tool.actions.length, directActions: direct.length, directChars,
    ownerInvocations: calls.length}));
})().catch((error) => { console.error(error); process.exit(1); });
