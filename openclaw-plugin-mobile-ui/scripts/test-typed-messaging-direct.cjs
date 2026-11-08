'use strict';
// Amine 08/11 : « la voix doit pouvoir faire cela et tout ce qui ressemble à ça » (SMS et e-mail). The playbooks
// projection carries samantha_messaging; the plugin declares it, shows it direct-only to the voice and app brain, keeps
// both actions behind the recap, and an undeclared catalogue tool never takes the other typed owners down with it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const typed = require('../dist/typedCapabilityTools.js');

const s24 = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json'), 'utf8'));
const device = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/playbooks-2026-10-31-device-typed-tool/device-assistance-tool.json'), 'utf8'));
const messaging = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/playbooks-2026-11-09-messaging-typed-tool/messaging-tool.json'), 'utf8'));
assert.equal(messaging.tool.name, 'samantha_messaging');
assert.equal(messaging.source.repository, 'sfar-amine/samantha-ui-playbooks');
assert.deepEqual(messaging.tool.actions.map((a) => a.action).sort(), ['messaging.email.send', 'messaging.sms.send']);
for (const action of messaging.tool.actions) {
  assert.equal(action.risk, 'external_send');
  assert.equal(action.confirmationRequired, true);
}

function descriptorsWith(tools) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-messaging-'));
  fs.mkdirSync(path.join(home, '.openclaw/capability-views'), {recursive: true});
  fs.writeFileSync(path.join(home, '.openclaw/capability-views/agent-tools.json'), JSON.stringify({...s24, tools}));
  const ctx = {senderIsOwner: true, agentId: 'main', sessionKey: 'agent:main:companion-chat-voice', sessionId: 'voice',
    assertInvocationCurrent() {}};
  return typed.createTypedCapabilityTools(ctx, {home, helperPath: path.join(home, 'helper.py')});
}

// Same samantha_web shape as test-typed-web-direct.cjs: the direct surface the S24 shows once both are activated.
const params = {type: 'object', properties: {query: {type: 'string', minLength: 1, maxLength: 200},
  responseLanguage: {type: 'string', enum: ['fr', 'en', 'ar', 'aeb']}, freshness: {type: 'string', enum: ['current', 'recent']}},
  required: ['query'], additionalProperties: false};
const web = {name: 'samantha_web', domain: 'web', description: 'Recherche Web publique (une recherche Codex, sources citées)',
  actions: ['samantha.app.web.answer', 'samantha.app.web.search'].map((action) => ({action, description: action, params,
    risk: 'read', confirmationRequired: false, directExecution: true, examples: [], execution: {kind: 'public_web', budgetMs: 40000}}))};
const descriptors = descriptorsWith([...s24.tools, device.tool, web, messaging.tool]);
const tool = descriptors.find((entry) => entry.name === 'samantha_messaging');
assert(tool, 'messaging tool exposed to the owner');
assert.equal(tool.catalogMode, 'direct-only');
assert(typed.DIRECT_TYPED_TOOLS.has('samantha_messaging'));
for (const action of ['messaging.sms.send', 'messaging.email.send']) {
  const line = tool.description.split('\n').find((entry) => entry.startsWith(action + ':'));
  assert(line && line.includes('(récapitulatif puis confirmation)'), `${action} keeps the recap`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../openclaw.plugin.json'), 'utf8'));
assert(manifest.contracts.tools.includes('samantha_messaging'), 'samantha_messaging declared in contracts.tools');
assert(typed.declaredPluginTools().has('samantha_messaging'));

// Prompt budget of the whole direct surface (schema + description, characters): 35 790 with the device owner and
// samantha_web (test-typed-web-direct.cjs, ceiling 36 000); samantha_messaging adds about 2 500 (38 259 measured).
// Amine 08/11: dictated SMS and e-mail are frequent enough to stay out of tool_search.
const directChars = descriptors.filter((entry) => typed.DIRECT_TYPED_TOOLS.has(entry.name))
  .reduce((total, entry) => total + entry.description.length + JSON.stringify(entry.parameters).length, 0);
assert(directChars <= 38500, `direct typed surface ${directChars} chars`);

// An undeclared catalogue tool is hidden alone: the Gateway would refuse the whole batch (S24 31/10 15:20).
const rogue = {...messaging.tool, name: 'samantha_not_declared_anywhere'};
const filtered = descriptorsWith([...s24.tools, device.tool, web, messaging.tool, rogue]);
assert(!filtered.some((entry) => entry.name === rogue.name), 'undeclared tool hidden');
assert(filtered.some((entry) => entry.name === 'samantha_agenda'), 'declared owners stay');
assert(filtered.some((entry) => entry.name === 'samantha_messaging'));
assert.equal(typed.declaredPluginTools(path.join(os.tmpdir(), 'no-such-manifest.json')), null, 'unreadable manifest filters nothing');

console.log(`typed messaging direct: OK (direct surface ${directChars} chars)`);
