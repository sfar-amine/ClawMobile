'use strict';
// Route web unique (S24 04/11, recette-web-20261104T163533): an owner web question took 92 s on the main agent:
// tool_search (7 s) to find the raw web_search tool, then three chained web_search calls (21, 27, 25 s).
// The playbooks projection now carries samantha_web (samantha.app.web.answer|search: one Codex hosted search through
// public_web). This checks the plugin side with the public factory: direct-only visibility with the single-search
// hint, a helper ceiling sized for the 30 s public-web budget, one typed owner invocation per call, prompt budget.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../dist/capabilityAgentGuard.js');
const typed = require('../dist/typedCapabilityTools.js');

const s24 = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json'), 'utf8'));
const device = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/playbooks-2026-10-31-device-typed-tool/device-assistance-tool.json'), 'utf8'));
const params = {type: 'object', properties: {query: {type: 'string', minLength: 1, maxLength: 200},
  responseLanguage: {type: 'string', enum: ['fr', 'en', 'ar', 'aeb']}, freshness: {type: 'string', enum: ['current', 'recent']}},
  required: ['query'], additionalProperties: false};
// Shape projected by samantha-ui-playbooks skill_intelligence/typed_tools.py (route web unique, PR #393 7f40e0b0).
const web = {name: 'samantha_web', domain: 'web', description: 'Recherche Web publique (une recherche Codex, sources citées)',
  actions: ['samantha.app.web.answer', 'samantha.app.web.search'].map((action) => ({action, description: action.endsWith('answer')
    ? 'Répondre à une question publique avec sources' : 'Trouver des sources publiques', params, risk: 'read',
  confirmationRequired: false, directExecution: true, examples: [], execution: {kind: 'public_web', budgetMs: 30000}}))};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-web-'));
const views = path.join(home, '.openclaw/capability-views');
fs.mkdirSync(views, {recursive: true});
fs.writeFileSync(path.join(views, 'agent-tools.json'), JSON.stringify({...s24, tools: [...s24.tools, device.tool, web]}));
assert.equal(typed.readTypedToolCatalogue(home).length, s24.tools.length + 2, 'catalogue validator accepts samantha_web');

const helper = path.join(home, 'helper.py');
const helperLog = path.join(home, 'helper-calls.jsonl');
fs.writeFileSync(helper, `import sys,json\np=json.load(sys.stdin)\nopen(${JSON.stringify(helperLog)},'a').write(json.dumps({'argv':sys.argv[1:],'command':p['command']})+'\\n')\n` +
  `print(json.dumps({'state':'COMPLETED','answer':'Le Brent cote 104,36 $. [s1]','facts':{'sources':[{'id':'s1','url':'https://www.reuters.com/markets/'}]}}))\n`);
const ctx = {senderIsOwner: true, agentId: 'main', sessionKey: 'agent:main:companion-chat-web', sessionId: 'session-web',
  messageChannel: 'whatsapp', assertInvocationCurrent() {}};
const descriptors = typed.createTypedCapabilityTools(ctx, {home, helperPath: helper});
const tool = descriptors.find((entry) => entry.name === 'samantha_web');
assert(tool, 'web tool exposed to the owner');
assert.equal(tool.catalogMode, 'direct-only');
assert(typed.DIRECT_TYPED_TOOLS.has('samantha_web'));
assert(!typed.DIRECT_TYPED_TOOLS.has('samantha_app'), 'samantha_app (many reads) stays behind tool_search');
assert.match(tool.description, /une seule action samantha\.app\.web\.answer/);
assert.match(tool.description, /n'en enchaîne pas d'autres/);
// S24 04/11 19:15 (recette-webseries-4): a 230-character query failed the schema (maxLength 200) before the search.
assert.match(tool.description, /query : quelques mots-clés, 200 caractères au plus/);
// Other tools never carry the web hint.
assert(!descriptors.find((entry) => entry.name === 'samantha_agenda').description.includes('samantha.app.web.answer'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../openclaw.plugin.json'), 'utf8'));
assert(manifest.contracts.tools.includes('samantha_web'), 'samantha_web declared in openclaw.plugin.json contracts.tools');
// A contact never sees the factory.
assert.equal(typed.createTypedCapabilityTools({...ctx, senderIsOwner: false}, {home, helperPath: helper}), null);

const directChars = descriptors.filter((entry) => typed.DIRECT_TYPED_TOOLS.has(entry.name))
  .reduce((total, entry) => total + entry.description.length + JSON.stringify(entry.parameters).length, 0);
// 34000 with the device owner (test-typed-device-direct.cjs); the two web actions add about 1 500.
assert(directChars <= 36000, `direct typed surface ${directChars} chars`);

(async () => {
  const args = {action: 'samantha.app.web.answer', params: {query: 'prix du Brent aujourd’hui', responseLanguage: 'fr'}};
  assert.equal(guard.agentCapabilityHook({toolName: tool.name, params: args, toolCallId: 'web-1'},
    {requester: {senderIsOwner: true}, agentId: 'main', runId: 'user-run-web', sessionKey: ctx.sessionKey, sessionId: ctx.sessionId}).block, undefined);
  const result = JSON.parse((await tool.execute('web-1', args)).content[0].text);
  assert.equal(result.state, 'COMPLETED');
  assert.match(result.answer, /\[s1\]/);
  const calls = fs.readFileSync(helperLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 1, 'one typed owner invocation');
  assert.deepEqual(calls[0].command, {operation: 'call', domain: 'web', action: 'samantha.app.web.answer',
    params: {query: 'prix du Brent aujourd’hui', responseLanguage: 'fr'}});
  // The public-web budget (30 s) plus graph and dialogue owners: never cut by the generic 30 s helper ceiling.
  assert.deepEqual(calls[0].argv, ['typed-tool', '--host-input-stdin', '--timeout', '45']);
  fs.rmSync(home, {recursive: true, force: true});
  console.log(JSON.stringify({ok: true, webActions: web.actions.length, directChars, ownerInvocations: calls.length}));
})().catch((error) => { console.error(error); process.exit(1); });
