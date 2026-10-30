'use strict';
// S24 30/10 22:57 (deployment dbe0f455, rolled back by the deploy parcours): with samantha_agenda direct-only, the brain
// called it with the provider's Responses id `call_<hex>|fc_<hex>` and the before_tool_call guard refused every call
// (capability_first_required), so Samantha answered « Agenda momentanément indisponible ». The real ids must be admitted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../dist/capabilityAgentGuard.js');
const tools = require('../dist/typedCapabilityTools.js');
const capture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-30-direct-call-id/direct-calls.json'), 'utf8'));
const catalogue = path.join(__dirname, '../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-direct-id-'));
const views = path.join(root, '.openclaw/capability-views'); fs.mkdirSync(views, {recursive: true});
fs.copyFileSync(catalogue, path.join(views, 'agent-tools.json'));
const helper = path.join(root, 'helper.py');
fs.writeFileSync(helper, "import sys,json\np=json.load(sys.stdin)\nprint(json.dumps({'state':'COMPLETED','received':p}))\n");
const ctx = {senderIsOwner: true, agentId: 'main', sessionKey: 'agent:main:recette-deploy', sessionId: 'session-1', assertInvocationCurrent() {}};
const host = {requester: {senderIsOwner: true}, agentId: 'main', runId: 'user-run-1', sessionKey: ctx.sessionKey, sessionId: ctx.sessionId};
const agenda = tools.createTypedCapabilityTools(ctx, {home: root, helperPath: helper}).find((tool) => tool.name === 'samantha_agenda');
assert(agenda, 'samantha_agenda in the S24 typed catalogue');
assert.equal(agenda.catalogMode, 'direct-only');
let checks = 2;
(async () => {
  for (const call of capture.calls) {
    assert.match(call.callId, /\|fc_/, 'real Responses id shape');
    assert.equal(call.result, guard.AGENT_CAPABILITY_REFUSAL, 'captured refusal before the fix');
    const args = {action: call.action, relation: 'new_request', params: {}};
    const admitted = guard.agentCapabilityHook({toolName: call.tool, params: args, toolCallId: call.callId}, host);
    assert.equal(admitted.block, undefined, call.callId);
    const result = JSON.parse((await agenda.execute(call.callId, args)).content[0].text);
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.received.command.action, call.action);
    assert.equal(result.received.host.invocationId, call.callId);
    // One execute per admitted invocation: the same id is not reusable.
    const replay = (await agenda.execute(call.callId, args)).content[0].text;
    assert.match(replay, /typed_host_admission_required/);
    checks += 7;
  }
  // Still refused: separators outside the id alphabet, empty and oversized ids.
  for (const bad of ['call_a|fc_b c', 'call_a/fc_b', '', 'x'.repeat(201)]) {
    assert.deepEqual(guard.agentCapabilityHook({toolName: 'samantha_agenda', params: {action: 'agenda.event.read', params: {}}, toolCallId: bad}, host),
      {block: true, blockReason: guard.AGENT_CAPABILITY_REFUSAL}); checks++;
  }
  fs.rmSync(root, {recursive: true, force: true});
  console.log(JSON.stringify({ok: true, checks}));
})().catch((error) => { console.error(error); process.exit(1); });
