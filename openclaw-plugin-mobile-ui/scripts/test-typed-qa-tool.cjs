'use strict';
// Amine 02/11 (« construis l'outil, ne ferme pas la pièce »): QA becomes the typed tool samantha_qa (playbooks skill
// `qa`, owner qa_testing/typed_qa.py). S24 02/11, read only: the compiled catalogue has 13 typed tools and
// qa.test_campaign has no typed call, so in brain-only mode the brain had no QA action. This checks the plugin side
// with the public factory: the catalogue validator accepts the new owner next to the S24 tools, samantha_qa is
// declared in contracts.tools (otherwise the Gateway refuses the whole typed batch, S24 31/10), stays searchable
// (not direct-only), marks exactly its four writes « récapitulatif puis confirmation », reaches the owner in one
// typed invocation, forwards confirm with only the receipt ids, and is never offered to a contact or a room.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../dist/capabilityAgentGuard.js');
const typed = require('../dist/typedCapabilityTools.js');

const fixtures = path.join(__dirname, '../fixtures');
const s24 = JSON.parse(fs.readFileSync(path.join(fixtures, 's24-2026-11-02-qa-typed-tool/s24-agent-tools-summary.json'), 'utf8'));
const qa = JSON.parse(fs.readFileSync(path.join(fixtures, 's24-2026-11-02-qa-typed-tool/qa-tool.json'), 'utf8'));
const base = JSON.parse(fs.readFileSync(path.join(fixtures, 's24-2026-10-25-typed-tools/compiled-agent-tools.json'), 'utf8'));
const device = JSON.parse(fs.readFileSync(path.join(fixtures, 'playbooks-2026-10-31-device-typed-tool/device-assistance-tool.json'), 'utf8'));

// The S24 capture: no samantha_qa yet, and qa.test_campaign reachable by no typed call.
assert.equal(s24.tools.length, 13);
assert(!s24.tools.some((tool) => tool.name === 'samantha_qa'));
assert.deepEqual(s24.qa_test_campaign.calls, []);
assert.equal(qa.source.repository, 'sfar-amine/samantha-ui-playbooks');
assert.equal(qa.tool.name, 'samantha_qa');
assert.equal(qa.tool.domain, 'qa');
const reads = ['qa.campaign.list', 'qa.campaign.status', 'qa.docs.list', 'qa.map.get', 'qa.report.latest'];
const writes = ['qa.campaign.cancel', 'qa.campaign.start', 'qa.map.approve', 'qa.plan.approve'];
assert.deepEqual(qa.tool.actions.map((action) => action.action).sort(), [...reads, ...writes].sort());
for (const action of qa.tool.actions) {
  assert.equal(action.risk, writes.includes(action.action) ? 'write' : 'read', action.action);
  assert.equal(action.confirmationRequired, writes.includes(action.action), action.action);
  assert.equal(action.executionMode, 'command', action.action);
}
assert.deepEqual(qa.catalogueRow.calls.map((call) => call.action).sort(), [...reads, ...writes].sort());
// After activation the compiled view counts the S24 tools plus this owner: still under the validator's 32 tools.
assert(s24.tools.length + 1 <= 32);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-qa-'));
const views = path.join(home, '.openclaw/capability-views');
fs.mkdirSync(views, {recursive: true});
fs.writeFileSync(path.join(views, 'agent-tools.json'), JSON.stringify({...base, tools: [...base.tools, device.tool, qa.tool]}));
assert.equal(typed.readTypedToolCatalogue(home).length, base.tools.length + 2, 'catalogue validator accepts the QA owner');

const helper = path.join(home, 'helper.py');
const helperLog = path.join(home, 'helper-calls.jsonl');
fs.writeFileSync(helper, `import sys,json\np=json.load(sys.stdin)\nopen(${JSON.stringify(helperLog)},'a').write(json.dumps(p['command'])+'\\n')\n` +
  `print(json.dumps({'state':'COMPLETED','answer':'2 campagne(s) de tests.','facts':{'campaigns':[]}}))\n`);
const ctx = {senderIsOwner: true, agentId: 'main', sessionKey: 'agent:main:companion-chat-qa', sessionId: 'session-qa',
  assertInvocationCurrent() {}};
const descriptors = typed.createTypedCapabilityTools(ctx, {home, helperPath: helper});
const tool = descriptors.find((entry) => entry.name === 'samantha_qa');
assert(tool, 'QA tool exposed to the owner');
// Rare owner: searchable through Tool Search, outside the direct prompt budget.
assert(!typed.DIRECT_TYPED_TOOLS.has('samantha_qa'));
assert.equal(tool.catalogMode, undefined);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../openclaw.plugin.json'), 'utf8'));
for (const entry of descriptors)
  assert(manifest.contracts.tools.includes(entry.name), `${entry.name} declared in openclaw.plugin.json contracts.tools`);
const lines = tool.description.split('\n');
for (const action of [...reads, ...writes]) {
  const line = lines.find((entry) => entry.startsWith(action + ':'));
  assert(line, action);
  assert.equal(line.includes('récapitulatif puis confirmation'), writes.includes(action), action);
}
assert.deepEqual(tool.parameters.properties.action.enum.filter((name) => name.startsWith('qa.')).sort(), [...reads, ...writes].sort());
assert(tool.parameters.properties.action.enum.includes('confirm') && tool.parameters.properties.action.enum.includes('cancel'));

// Never offered to a contact, a contact agent or a room agent (the QA room keeps its own path until the follow-up).
assert.equal(typed.createTypedCapabilityTools({...ctx, senderIsOwner: false}, {home, helperPath: helper}), null);
assert.equal(typed.createTypedCapabilityTools({...ctx, agentId: 'contacts-qa'}, {home, helperPath: helper}), null);
const roomSession = 'agent:contacts-qa:whatsapp:direct:+21610000077';
assert.equal(guard.agentCapabilityHook({toolName: 'samantha_qa', params: {action: 'qa.campaign.list', params: {}}, toolCallId: 'room-1'},
  {requester: {senderIsOwner: false}, agentId: 'contacts-qa', runId: 'room-run', sessionKey: roomSession}).block, true);
const pulseRoom = 'agent:contacts-pulse:whatsapp:direct:+21610000078';
assert.equal(guard.agentCapabilityHook({toolName: 'samantha_qa', params: {action: 'qa.campaign.list', params: {}}, toolCallId: 'room-2'},
  {requester: {senderIsOwner: false}, agentId: 'contacts-pulse', runId: 'room-run-2', sessionKey: pulseRoom}).block, true);
assert(!guard.PULSE_ROOM_TOOLS.has('samantha_qa'));

(async () => {
  const bind = (callId, args) => assert.equal(guard.agentCapabilityHook({toolName: tool.name, params: args, toolCallId: callId},
    {requester: {senderIsOwner: true}, agentId: 'main', runId: 'user-run-' + callId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId}).block, undefined);
  const list = {action: 'qa.campaign.list', params: {limit: 5}};
  bind('qa-1', list);
  const result = JSON.parse((await tool.execute('qa-1', list)).content[0].text);
  assert.equal(result.state, 'COMPLETED');
  // A replay of the same call id without a new host admission is refused before any owner process.
  const replay = await tool.execute('qa-1', list);
  assert.equal(replay.isError, true);
  const confirm = {action: 'confirm', params: {confirmationId: 'goal-qa', payloadHash: 'a'.repeat(64)}};
  bind('qa-2', confirm);
  await tool.execute('qa-2', confirm);
  const calls = fs.readFileSync(helperLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls, [
    {operation: 'call', domain: 'qa', action: 'qa.campaign.list', params: {limit: 5}},
    {operation: 'confirm', domain: 'qa', confirmationId: 'goal-qa', payloadHash: 'a'.repeat(64)},
  ]);
  fs.rmSync(home, {recursive: true, force: true});
  console.log(JSON.stringify({ok: true, s24Tools: s24.tools.length, qaActions: qa.tool.actions.length, confirmedWrites: writes.length,
    ownerInvocations: calls.length}));
})().catch((error) => { console.error(error); process.exit(1); });
