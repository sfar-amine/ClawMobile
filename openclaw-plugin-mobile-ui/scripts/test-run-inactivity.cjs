const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samantha-r2-v2-'));
process.env.OPENCLAW_STATE_DIR = root;
const folder = path.join(root, 'clawmobile-companion');
fs.mkdirSync(folder);
const registry = path.join(folder, 'runs.json');
const owner = path.join(root, 'owner.sqlite');
const gateway = path.join(root, 'gateway.py');
const calls = path.join(root, 'calls.jsonl');
const block = path.join(root, 'block'), started = path.join(root, 'started'), release = path.join(root, 'release');
// Mock the owner API over an actual SQLite fixture, without legacy JSON files.
// The fixture schema is test-only; runtime code knows only Gateway contracts.
fs.writeFileSync(gateway, `#!/usr/bin/env python3
import json, sqlite3, sys, os, time
db=sqlite3.connect(${JSON.stringify(owner)})
method=sys.argv[3]
if method=='chat.history' and os.path.exists(${JSON.stringify(block)}):
 open(${JSON.stringify(started)},'w').close()
 while not os.path.exists(${JSON.stringify(release)}): time.sleep(0.01)
with open(${JSON.stringify(calls)},'a') as f: f.write(json.dumps(method)+'\\n')
row=db.execute('select response from responses where method=?',(method,)).fetchone()
if row is None: sys.exit(1)
print(row[0])
`);
fs.chmodSync(gateway, 0o700);
process.env.CLAWMOBILE_OPENCLAW_BIN = gateway;
const api = require('../dist/companion/runs');
const {expectedCompanionSessionKey} = require('../dist/companion/openclawAgentClient');
const now = Date.now(), old = now - 30 * 60 * 1000;
const run = (id, extra = {}) => ({runId: id, sessionId: id, text: 'Unique request ' + id,
  acceptedAt: old, updatedAt: old, state: 'running', executionSource: 'capability_first', ...extra});
const message = (role, content, timestamp, extra = {}) => ({role, content, timestamp, ...extra});
function write(run, payments = [], confirmations = []) {
  fs.writeFileSync(registry, JSON.stringify({version: 1, runs: [run], archivedSessionIds: [],
    paymentRequests: payments, ownerConfirmations: confirmations, runDeletions: []}));
}
function responses(values) {
  const result = spawnSync('python3', ['-c', `import sqlite3,json,sys
db=sqlite3.connect(sys.argv[1]); db.execute('create table if not exists responses(method text primary key,response text)'); db.execute('delete from responses')
for k,v in json.loads(sys.argv[2]).items(): db.execute('insert into responses values(?,?)',(k,json.dumps(v)))
db.commit()`, owner, JSON.stringify(values)], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}
function ownerProof(r, messages, extra = {}) {
  responses({'sessions.list': {sessions: [{key: expectedCompanionSessionKey(r.sessionId),
    hasActiveRun: false, pendingApprovals: [], ...extra}]}, 'chat.history': {messages}});
}
const stored = () => JSON.parse(fs.readFileSync(registry)).runs[0];
const callsCount = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
async function status(r) {return api.getRunStatus(r.runId);}
(async () => {
  // 1. No sessions.json and no readable evidence never imply expiration.
  let r = run('no-proof'); write(r); responses({});
  assert.equal((await status(r)).state, 'running');
  assert.equal(stored().error, undefined);
  assert.equal(fs.existsSync(path.join(root, 'agents/main/sessions/sessions.json')), false);

  // SQLite owner proof, unlike an absent file, can establish inactivity.
  r = run('late', {decision: {version: 2, capability: 'read.balance',
    confirmationRequired: false, humanBoundary: null}}); write(r);
  const first = message('user', r.text, old);
  ownerProof(r, [first]);
  assert.equal((await status(r)).status, 'expired');
  assert.equal(stored().state, 'failed');

  // 3. A real late result replaces expiration and persists a correction receipt.
  ownerProof(r, [first, message('assistant', 'Real late result', now - 1000, {stopReason: 'stop'})]);
  let result = await status(r);
  assert.equal(result.state, 'done'); assert.equal(result.result, 'Real late result');
  assert.equal(result.inactivityCorrectionReceipt.from, 'expired');
  const receipt = result.inactivityCorrectionReceipt;
  assert.deepEqual(stored().inactivityCorrectionReceipt, receipt);
  assert.deepEqual((await status(r)).inactivityCorrectionReceipt, receipt);
  const restarted = spawnSync(process.execPath, ['-e', `require('./dist/companion/runs').getRunStatus('late').then(r => console.log(JSON.stringify(r)))`], {encoding: 'utf8'});
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout).inactivityCorrectionReceipt, receipt);

  for (const [id, read] of [
    ['late-summary', r => api.listRunSummaries()],
    ['late-list', r => api.listRuns()],
    ['late-callback', async r => {await api.settleSubmittedRun(r.runId, 'done', 'Native callback result'); return [await status(r)];}]
  ]) {
    r = run(id); write(r); ownerProof(r, [message('user', r.text, old)]);
    assert.equal((await status(r)).status, 'expired');
    ownerProof(r, [message('user', r.text, old), message('assistant', 'Late proof', now - 1000, {stopReason: 'stop'})]);
    if (id === 'late-callback') ownerProof(r, [message('user', r.text, old)]);
    const rows = await read(r); assert.equal(rows[0].state, 'done', id);
    assert.equal(rows[0].inactivityCorrectionReceipt.action, 'correct_run_expiration');
  }

  // 2. An outstanding tool is live even with an old timestamp and false session flag.
  r = run('long-tool'); write(r);
  ownerProof(r, [message('user', r.text, old), message('assistant',
    [{type: 'toolCall', id: 'long-tool-call', name: 'legitimate'}], old + 1000)]);
  assert.equal((await status(r)).state, 'running'); assert.equal(stored().error, undefined);

  // 4. Different caller origin IDs cannot remove bank/biometric protection.
  for (const [id, payments, confirmations, decision] of [
    ['bank', [{state: 'requires_bank_action', ownerConfirmationId: 'canonical-confirm',
      draft: {origin: {id: 'different-caller-origin'}}}], [], undefined],
    ['biometric', [], [{id: 'canonical-confirm', state: 'awaiting_owner',
      intent: {origin: {id: 'another-origin'}}}], undefined],
    ['capability', [], [], {version: 2, capability_id: 'payment.topup'}],
    ['nested-capability', [], [], {version: 2, selected: {capability: 'payment.topup'}, confirmationRequired: false}],
    ['human-boundary', [], [], {version: 2, humanBoundary: 'owner_biometric'}],
    ['unknown-guard', [{id: 'unknown-record'}], [], undefined]
  ]) {
    r = run(id, {decision}); write(r, payments, confirmations); ownerProof(r, [message('user', r.text, old)]);
    const before = callsCount(); assert.equal((await status(r)).state, 'running');
    assert.equal(callsCount(), before, 'protected runs must never be transcript candidates');
    assert.deepEqual(JSON.parse(fs.readFileSync(registry)).paymentRequests, payments);
    assert.deepEqual(JSON.parse(fs.readFileSync(registry)).ownerConfirmations, confirmations);
  }

  // Unknown owner activity, duplicate prompts, recent progress and unreadable
  // histories are not negative proof. Capability-first shares the same guard.
  for (const [id, makeMessages, flags] of [
    ['unknown-owner', r => [message('user', r.text, old)], {hasActiveRun: null}],
    ['recent-progress', r => [message('user', r.text, old), message('assistant', 'working', now - 1000)], {}],
    ['duplicate-prompt', r => [message('user', r.text, old), message('user', r.text, old + 1000)], {}],
    ['missing-approvals', r => [message('user', r.text, old)], {pendingApprovals: null}],
    ['undated', r => [message('user', r.text, undefined)], {}],
    ['older-unrelated-turn', r => [message('user', r.text, old - 60000)], {}],
    ['active-owner', r => [message('user', r.text, old)], {hasActiveRun: true}]
  ]) {
    r = run(id); write(r); ownerProof(r, makeMessages(r), flags);
    assert.equal((await status(r)).state, 'running', id);
  }
  // A stale owner read cannot overwrite deletion, archive, a new failure,
  // a native result or a guard added while evidence is being fetched.
  for (const mutation of ['delete', 'archive', 'result', 'failure', 'guard']) {
    r = run('race-' + mutation); write(r); ownerProof(r, [message('user', r.text, old)]);
    for (const file of [started, release]) try {fs.unlinkSync(file);} catch {}
    fs.writeFileSync(block, 'block');
    const reading = status(r);
    for (let i = 0; i < 200 && !fs.existsSync(started); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(started), 'owner evidence read did not start');
    if (mutation === 'delete') await api.deleteSession(r.sessionId);
    if (mutation === 'archive') await api.archiveSession(r.sessionId);
    if (mutation === 'result') await api.settleSubmittedRun(r.runId, 'done', 'Concurrent real result');
    if (mutation === 'failure') await api.markSubmittedRunFailed(r.runId, 'Definitive failure');
    if (mutation === 'guard') {
      const value = JSON.parse(fs.readFileSync(registry));
      value.ownerConfirmations = [{state: 'awaiting_owner', intent: {origin: {id: 'foreign'}}}];
      fs.writeFileSync(registry, JSON.stringify(value));
    }
    fs.writeFileSync(release, 'release'); await reading; fs.unlinkSync(block);
    const value = JSON.parse(fs.readFileSync(registry));
    if (mutation === 'delete') assert.equal(value.runs.length, 0);
    if (mutation === 'archive') assert.deepEqual(value.archivedSessionIds, [r.sessionId]);
    if (mutation === 'result') assert.equal(value.runs[0].result, 'Concurrent real result');
    if (mutation === 'failure') assert.equal(value.runs[0].error, 'Definitive failure');
    if (['archive', 'guard'].includes(mutation)) assert.equal(value.runs[0].state, 'running');
  }
  // The targeted status must not be starved by the 25-candidate list bound.
  r = run('beyond-list-bound'); write(r);
  const many = JSON.parse(fs.readFileSync(registry));
  many.runs = [...Array.from({length: 30}, (_, i) => run('earlier-' + i)), r];
  fs.writeFileSync(registry, JSON.stringify(many));
  ownerProof(r, [message('user', r.text, old)]);
  assert.equal((await status(r)).status, 'expired');
  ownerProof(r, [message('user', r.text, old), message('assistant', 'Target result', now - 1000, {stopReason: 'stop'})]);
  assert.equal((await status(r)).result, 'Target result');
  fs.writeFileSync(registry, '{bad registry');
  responses({});
  assert.equal((await api.getRunStatus('missing')).state, 'unknown');
  console.log(JSON.stringify({suite: 'R2-v2', passed: true, required: {
    noReadableProof: 'passed', longActiveTool: 'passed', lateResult: 'passed', bankBiometricDifferentOrigins: 'passed'},
    sqliteOwnerFixture: 'passed', protectedCandidatesExcluded: 'passed', corruptRegistryStatus: 'passed'}));
})().catch(error => {console.error(error); process.exitCode = 1;});
