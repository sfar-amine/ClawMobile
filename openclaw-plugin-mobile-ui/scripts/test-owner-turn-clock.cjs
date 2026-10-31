'use strict';
// S24 31/10 (brain-only voice bench): « quelle heure est-il » 12.0 s against 6.2 s for a no-tool turn: the brain called a
// tool for the time. Runs the exact public SDK 2026.9.6 functions (fixtures/s24-2026-10-31-owner-clock) to show the
// cause and that the Companion's Tunis clock envelope reaches the model as is, then the real submission path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const here = path.join(__dirname, '../fixtures/s24-2026-10-31-owner-clock');
const provenance = JSON.parse(fs.readFileSync(path.join(here, 'provenance.json'), 'utf8'));
const read = (name) => {
  const source = zlib.gunzipSync(fs.readFileSync(path.join(here, name + '.gz'))).toString('utf8');
  const entry = provenance.modules.find((m) => m.name === name);
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), entry.sha256, name);
  return source;
};
const esm = (source) => source.split('\n').filter((line) => !/^(import|export) /.test(line)).join('\n');
const sandbox = {Intl, Date, Number, Object, String, Math, resolveDateTimestampMs: (value) => Number.isFinite(value) ? value : Date.now()};
vm.createContext(sandbox);
vm.runInContext(esm(read('format-datetime-CSLJIAzN.mjs')) + '\n' + esm(read('date-time-CaOYkXPL.mjs')), sandbox);

// The S24-identical builtin module: the LLM-boundary stamp of user messages.
const prep = path.join(__dirname, '../fixtures/s24-2026-10-26-gateway-prep-stages');
const builtin = zlib.gunzipSync(fs.readFileSync(path.join(prep, 'builtin-openclaw-q1hiFm14.mjs.gz'))).toString('utf8');
const prepProvenance = JSON.parse(fs.readFileSync(path.join(prep, 'provenance.json'), 'utf8'));
const builtinEntry = JSON.stringify(prepProvenance).match(/"name":\s*"builtin-openclaw-q1hiFm14\.mjs"[^}]*"sha256":\s*"([a-f0-9]{64})"/)[1];
assert.equal(crypto.createHash('sha256').update(builtin).digest('hex'), builtinEntry);
const slice = (start, end) => { const a = builtin.indexOf(start); const b = builtin.indexOf(end, a); assert(a >= 0 && b > a, start); return builtin.slice(a, b); };
vm.runInContext([
  slice('function buildTimestampPrefix(date, opts) {', '/**\n* Injects'),
  slice('const BOUNDARY_TIMESTAMP_ENVELOPE_RE', 'function normalizeMessagesForLlmBoundary'),
  slice('function stampUserTextWithMessageTimestamp(', 'function messageContentMatchesCurrentUserText'),
].join('\n'), sandbox);

// Wall clock of the S24 bench (31/10, Tunis = UTC+1) and two edge instants (midnight in Tunis, year change).
const instants = [Date.UTC(2026, 9, 31, 8, 21), Date.UTC(2026, 9, 31, 23, 30), Date.UTC(2026, 11, 31, 23, 5)];

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-clock-'));
const previousHome = os.homedir;
os.homedir = () => home;
const work = path.join(home, '.openclaw/workspace');
fs.mkdirSync(path.join(work, 'context'), {recursive: true});
fs.writeFileSync(path.join(work, 'SOUL.md'), 'CLOCK_IDENTITY'); fs.writeFileSync(path.join(work, 'USER.md'), 'CLOCK_USER');
fs.writeFileSync(path.join(work, 'context/HYBRID_CONTEXT.md'), 'CLOCK_CONTINUITY');
fs.writeFileSync(path.join(work, 'context/OPERATING_RULES.md'), 'CLOCK_RULES\n## Règles spécialisées\nCLOCK_SPECIALIZED\n');
const output = path.join(home, 'params.json'), cli = path.join(home, 'gateway-fixture.py');
fs.writeFileSync(cli, '#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\np=json.loads(sys.argv[sys.argv.index("--params")+1]);Path(' + JSON.stringify(output) + ').write_text(json.dumps(p));print(json.dumps({"runId":p["idempotencyKey"],"status":"accepted"}))\n');
fs.chmodSync(cli, 0o700);
process.env.CLAWMOBILE_OPENCLAW_BIN = cli;
const client = require('../dist/companion/openclawAgentClient');
const {stripConversationTransport} = require('../dist/companion/conversationText');

(async () => {
  const realNow = Date.now;
  try {
    // 1. Cause: the system prompt has the date only and sends the brain to session_status for the time.
    const section = Array.from(sandbox.buildTemporalContextSection({userDate: '2026-10-31', userTimezone: 'Africa/Tunis', sessionStatusAvailable: true}));
    assert.deepEqual(section, ['## Temporal Context', 'Current date: 2026-10-31', 'Time zone: Africa/Tunis',
      'For the exact current time, use `session_status`.', '']);

    // 2. Same envelope format as the SDK, in Tunis time whatever the host zone.
    for (const at of instants) {
      const sdk = sandbox.formatZonedTimestamp(new Date(at), {timeZone: 'Africa/Tunis', displayWeekday: true});
      assert.equal(client.ownerTurnClockPrefix(at), `[${sdk}] `);
    }
    assert.equal(client.ownerTurnClockPrefix(instants[0]), '[Sat 2026-10-31 09:21 GMT+1] ');
    assert.equal(client.ownerTurnClockPrefix(instants[1]), '[Sun 2026-11-01 00:30 GMT+1] ');
    assert.equal(client.ownerTurnClockPrefix(instants[2]), '[Fri 2027-01-01 00:05 GMT+1] ');

    // 3. The LLM boundary keeps the Companion envelope; without it the host zone (UTC on a bare host) would stamp the turn.
    const label = '[companion-session:clock]\nquelle heure est-il';
    const bare = sandbox.stampUserTextWithMessageTimestamp(label, instants[0], 'UTC', true);
    assert.equal(bare, '[Sat 2026-10-31 08:21 UTC] ' + label, 'host zone stamp is one hour off for Tunis');
    const stamped = client.ownerTurnClockPrefix(instants[0]) + label;
    assert.equal(sandbox.stampUserTextWithMessageTimestamp(stamped, instants[0] + 60_000, 'UTC', true), stamped, 'no second stamp');
    assert.equal(sandbox.stampUserTextWithMessageTimestamp(stamped, instants[0], 'Africa/Tunis', true), stamped);

    // 4. Real submission path: owner turns carry the envelope and the static clock notice; nothing else changes.
    Date.now = () => instants[0];
    await client.submitToOpenClawAgent('quelle heure est-il', 'clock-1', 'clock', {authority: 'owner'});
    const first = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(first.message, '[Sat 2026-10-31 09:21 GMT+1] [companion-session:clock]\nquelle heure est-il');
    assert.equal(stripConversationTransport(first.message), 'quelle heure est-il', 'display strips the envelope and the label');
    assert(first.extraSystemPrompt.endsWith(client.OWNER_CLOCK_NOTICE), 'notice closes the owner context (no language prompt here)');
    assert.match(client.OWNER_CLOCK_NOTICE, /sans aucun outil : ni session_status, ni tool_search/);
    assert(!/\d{2}:\d{2}/.test(client.OWNER_CLOCK_NOTICE.replace('[Sat 2026-10-31 14:05 GMT+1]', '')), 'the notice holds no live time');
    Date.now = () => instants[1];
    await client.submitToOpenClawAgent('on est quel jour', 'clock-2', 'clock', {authority: 'owner', responseLanguage: 'fr'});
    const second = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(second.message, '[Sun 2026-11-01 00:30 GMT+1] [companion-session:clock]\non est quel jour');
    // Prompt cache: the system context does not change with the clock (the language line is per request, as before).
    assert.equal(second.extraSystemPrompt, first.extraSystemPrompt + '\n\n' + client.responseLanguageInstruction('fr'));
    // Non-owner and slash turns are unchanged.
    await client.submitToOpenClawAgent('quelle heure est-il', 'clock-3', 'clock');
    const publicParams = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(publicParams.message, '[companion-session:clock]\nquelle heure est-il');
    assert(!Object.hasOwn(publicParams, 'extraSystemPrompt'));
    await client.submitToOpenClawAgent('/status', 'clock-4', 'clock', {authority: 'owner'});
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).message, '/status');
    console.log(JSON.stringify({ok: true, prefix: client.ownerTurnClockPrefix(instants[0]), sdkTemporalContext: section[3],
      boundaryKeepsEnvelope: true, noticeChars: client.OWNER_CLOCK_NOTICE.length}));
  } finally {
    Date.now = realNow; os.homedir = previousHome;
    fs.rmSync(home, {recursive: true, force: true});
  }
})().catch((error) => { console.error(error); process.exit(1); });
