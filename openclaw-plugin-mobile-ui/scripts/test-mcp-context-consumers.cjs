// Synthetic transport envelopes over the existing request_context argv contract.
// The S24 identity/provenance capture is covered by test-mcp-context-provenance.
// No phone, real Memory Core database or inference is touched by these tests.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-consumers-'));
const previous = Object.fromEntries(['CLAW_UI_PLAYBOOKS_ROOT', 'SAMANTHA_MEMORY_OWNER'].map(k => [k, process.env[k]]));
const originalHomedir = os.homedir;
const calls = path.join(root, 'calls.jsonl');
const acknowledgements = path.join(root, 'acks.jsonl');
const workspace = path.join(root, '.openclaw', 'workspace');
const playbooks = path.join(workspace, 'ui-playbooks');
fs.mkdirSync(path.join(playbooks, 'tools'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'context'), { recursive: true });
const rule = path.join(workspace, 'SOUL.md');
const global = path.join(workspace, 'context', 'HYBRID_CONTEXT.md');
fs.writeFileSync(rule, 'Synthetic context rule. No user data.\n');
fs.writeFileSync(global, 'Synthetic shared facts, revision 4. No active conversation.\n');
const ruleHash = crypto.createHash('sha256').update(fs.readFileSync(rule)).digest('hex');
const owner = path.join(root, 'context-store.py');
fs.writeFileSync(owner, `import sys,json\nopen(${JSON.stringify(acknowledgements)},'a').write(json.dumps(sys.argv[1:])+'\\n')\nprint('{}')\n`);
fs.writeFileSync(path.join(playbooks, 'tools', 'request_context.py'), `
import sys,json
a=sys.argv[1:]
open(${JSON.stringify(calls)},'a').write(json.dumps(a)+'\\n')
def value(key,default=None):
 return a[a.index(key)+1] if key in a else default
after=int(value('--after')) if '--after' in a else None
known=json.loads(value('--known-contracts','{}'))
baseline=json.loads(value('--global-baseline','{}'))
if '--uncertain' in a: after,known,baseline=None,{},{}
events=[{'id':'synthetic-'+str(i),'revision':i,'kind':'learning','text':'Synthetic fact '+str(i)} for i in range(1,5) if after is None or i>after]
if after is not None: events=events[:2]
last=events[-1]['revision'] if events else after
required=[] if known.get('SOUL.md')==${JSON.stringify(ruleHash)} else ['SOUL.md']
global_read=not baseline or after is None
if global_read:required.append('context/HYBRID_CONTEXT.md')
print(json.dumps({'version':2,'surface':value('--surface'),'mode':'rebuild' if '--uncertain' in a else 'cold' if after is None else 'delta',
 'read_only':True,'cursor_advanced':False,
 'contracts':[{'key':'SOUL.md','path':${JSON.stringify(rule)},'sha256':${JSON.stringify(ruleHash)},'read_required':'SOUL.md' in required}],
 'context':{'fromRevision':after,'toRevision':4,'lastReturnedRevision':last,'truncated':last is not None and last<4,'events':events},
 'global':{'path':${JSON.stringify(global)},'read_required':global_read,'revision':4},
 'readiness':{'state':'requires_reads' if required else 'ready','required_reads':required}}))
`);
os.homedir = () => root;
process.env.CLAW_UI_PLAYBOOKS_ROOT = playbooks;
process.env.SAMANTHA_MEMORY_OWNER = owner;
const { handleMcpRelayRequest } = require('../dist/companion/mcpBridge');
let id = 0, checks = 0;
const invoke = (args = {}) => handleMcpRelayRequest({ requestId: 'consumer-' + (++id), clientId: 'chatgpt', profile: 'chat-owner-shadow', tool: 'claw_context', arguments: { query: 'Synthetic fixture', ...args } });
const revisions = result => result.bundle.context.events.map(row => row.revision);
const check = (condition, message) => { assert.ok(condition, message); checks++; };

(async () => { try {
  const a = await invoke();
  const b = await invoke({ conversation_ref: 'another-thread', clientId: 'different', profile: 'chat-owner' });
  assert.deepEqual(revisions(a), [1,2,3,4]); checks++;
  assert.deepEqual(b.required_reads, a.required_reads); checks++;
  assert.deepEqual(revisions(b), revisions(a)); checks++;
  check(b.bundle.surface === 'chat', 'untrusted conversation/client/profile arguments do not change admitted provenance');

  // Discard the response, then request the same page again: no receipt was lost
  // and no hidden server acknowledgement can skip its events or required reads.
  await invoke({ after_revision: 0 });
  const replay = await invoke({ after_revision: 0 });
  assert.deepEqual(revisions(replay), [1,2]); checks++;
  check(replay.bundle.context.truncated && replay.bundle.context.lastReturnedRevision === 2, 'partial page keeps its actual returned boundary');
  const next = await invoke({ after_revision: 2 });
  assert.deepEqual(revisions(next), [3,4]); checks++;
  const independent = await invoke();
  assert.deepEqual(revisions(independent), [1,2,3,4]); checks++;

  const base = { revision: 4, sha256: 'a'.repeat(64), semantic_sha256: 'b'.repeat(64), foundation_sha256: 'c'.repeat(64) };
  const integrated = await invoke({ after_revision: 4, known_contracts: { 'SOUL.md': ruleHash }, global_baseline: base });
  check(integrated.required_reads.length === 0 && revisions(integrated).length === 0, 'an explicitly integrated base still enables bounded hot calls');
  const rebuilt = await invoke({ after_revision: 4, known_contracts: { 'SOUL.md': ruleHash }, global_baseline: base, uncertain: true });
  check(rebuilt.required_reads.length === 2 && rebuilt.bundle.mode === 'rebuild', 'uncertain consumer reconstructs instead of inheriting an implicit base');
  check(!fs.existsSync(acknowledgements), 'no cursor acknowledgement or owner write occurs');
  check([a,b,replay,next,independent,integrated,rebuilt].every(x => x.bundle.cursor_advanced === false && x.bundle.context_consumption.state === 'not_attested'), 'construction never attests consumption');
  const argv = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  check(argv.every(row => !row.includes('--session')), 'no shared authenticated-client cursor is consulted');
  const explicit = argv.at(-2);
  check(explicit.includes('--after') && explicit.includes('--known-contracts') && explicit.includes('--global-baseline'), 'existing explicit arguments remain forwarded');
  console.log(`MCP consumers: ${checks}/${checks} checks passed (synthetic transport; no S24 effect)`);
} finally {
  os.homedir = originalHomedir;
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
} })().catch(error => { console.error(error); process.exitCode = 1; });
