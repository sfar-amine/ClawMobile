'use strict';
// S24 02/11 (deploy 20e36415, then 0c5a9b46 after runtime-sync 10:24): every typed samantha_* call answered
// typed_host_admission_required. OpenClaw 2026.10.9 had loaded openclaw-plugin-mobile-ui three times in the Gateway
// (plugin-captures/963b558c…: builds 10:25:19, 10:25:56, 10:28:48), and the before_tool_call hook of one copy recorded
// its proof in a Map the tool of another copy could not see. Two copies of the built plugin, loaded side by side,
// must share the proof: hook in copy A, execute in copy B. Authored fixtures only (S24 typed catalogue of 25/10).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plugin = path.join(__dirname, '..');
const copies = ['a', 'b'].map((name) => {
  const dir = path.join(plugin, `.instance-${name}-${process.pid}`);
  fs.cpSync(path.join(plugin, 'dist'), dir, {recursive: true});
  return dir;
});
const cleanup = () => copies.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true}));
process.on('exit', cleanup);
const guardA = require(path.join(copies[0], 'capabilityAgentGuard.js'));
const guardB = require(path.join(copies[1], 'capabilityAgentGuard.js'));
const toolsB = require(path.join(copies[1], 'typedCapabilityTools.js'));
assert.notStrictEqual(guardA, guardB, 'two distinct module instances, as in the Gateway');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-shared-'));
const views = path.join(root, '.openclaw/capability-views'); fs.mkdirSync(views, {recursive: true});
fs.copyFileSync(path.join(plugin, 'fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json'), path.join(views, 'agent-tools.json'));
const helper = path.join(root, 'helper.py');
fs.writeFileSync(helper, "import sys,json\np=json.load(sys.stdin)\nprint(json.dumps({'state':'COMPLETED','received':p}))\n");
const ctx = {senderIsOwner: true, agentId: 'main', sessionKey: 'agent:main:recette-deploy', sessionId: 'session-1', assertInvocationCurrent() {}};
const host = {requester: {senderIsOwner: true}, agentId: 'main', runId: 'user-run-1', sessionKey: ctx.sessionKey, sessionId: ctx.sessionId};
const agenda = toolsB.createTypedCapabilityTools(ctx, {home: root, helperPath: helper}).find((tool) => tool.name === 'samantha_agenda');
assert(agenda, 'samantha_agenda in the S24 typed catalogue');
(async () => {
  const args = {action: 'agenda.event.read', relation: 'new_request', params: {}};
  // Hook in copy A, execute in copy B: admitted once.
  assert.equal(guardA.agentCapabilityHook({toolName: 'samantha_agenda', params: args, toolCallId: 'call-shared-1'}, host).block, undefined);
  const result = JSON.parse((await agenda.execute('call-shared-1', args)).content[0].text);
  assert.equal(result.state, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.received.host.invocationId, 'call-shared-1');
  // Still one execute per admitted call, across copies.
  assert.match((await agenda.execute('call-shared-1', args)).content[0].text, /typed_host_admission_required/);
  // Still refused without any hook proof, and with arguments changed after the hook.
  assert.match((await agenda.execute('call-shared-unseen', args)).content[0].text, /typed_host_admission_required/);
  guardA.agentCapabilityHook({toolName: 'samantha_agenda', params: args, toolCallId: 'call-shared-2'}, host);
  assert.match((await agenda.execute('call-shared-2', {...args, action: 'agenda.event.create'})).content[0].text, /typed_host_admission_required/);
  // The registry is defined once for the process and cannot be replaced by a later copy.
  const key = Symbol.for('samantha.typed-invocations.v1');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false); assert.equal(descriptor.enumerable, false);
  fs.rmSync(root, {recursive: true, force: true});
  console.log('typed admission shared across plugin copies: ok');
})().catch((error) => { console.error(error); process.exit(1); });
