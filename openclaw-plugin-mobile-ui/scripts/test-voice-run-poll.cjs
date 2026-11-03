'use strict';
// Voice brain turn reads (S24 31/10 latency): the voice polled getRunStatus every 500 ms, each poll parsing runs.json
// twice while the brain works. voiceRunStatus answers a run this process follows from memory, so the voice polls every
// 100 ms with no registry read until the run is terminal. Settlement instants come from the real S24 brain runs
// (fixtures/s24-2026-10-26-gateway-terminal-timing, fixtures/s24-2026-10-25-gateway-observation).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-run-poll-'));
process.env.OPENCLAW_STATE_DIR = home; process.env.CLAWMOBILE_AGENT_ID = 'main';
const terminalTiming = require('../fixtures/s24-2026-10-26-gateway-terminal-timing/native-timing.json');
const voiceCapture = require('../fixtures/s24-2026-10-25-gateway-observation/native-timing.json');
const client = require('../dist/companion/openclawAgentClient');
client.callOpenClawGateway = async () => { throw Error('no Gateway read expected'); };
const runs = require('../dist/companion/runs');
const {delegateVoiceTurnToBrain, VOICE_BRAIN_POLL_MS} = require('../dist/companion/voiceBrainDelegation');
const registryFile = path.join(home, 'clawmobile-companion/runs.json');
const originalRead = fs.promises.readFile;
let registryReads = 0;
fs.promises.readFile = function (file, ...args) { if (String(file) === registryFile) registryReads++; return originalRead.call(this, file, ...args); };
const sessionKey = (sid) => 'agent:main:companion-chat-' + sid;
const terminal = (runId) => ({runId, status: 'ok', summary: 'completed', result: {payloads: [{text: 'Réponse publique.'}], meta: {stopReason: 'stop'}}});
let serial = 0;
async function followed(sid) {
  const reservation = await runs.reserveSubmittedRun('Question publique', sid, 'client-poll-' + (++serial), {ownerAdmitted: true, userText: 'Question publique'});
  const runId = reservation.status.runId;
  const observer = await runs.observeGatewayRun(runId, sessionKey(sid));
  observer.sent();
  await new Promise((resolve) => setTimeout(resolve, 30)); // the owner's queued send write, outside the polls
  return {runId, observer};
}

// One voice turn with a deterministic clock: the observer settles the run when the clock crosses settleAt.
async function voiceTurn(settleAt, poll, status) {
  const {runId, observer} = await followed('turn-' + serial);
  let clock = 0, settled = false;
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; if (!settled && clock >= settleAt) { settled = true; await observer.final(terminal(runId)); } };
  const ctx = {sessionId: 'turn', clientRunId: 'voice-' + serial, admission: {}, assertCurrent() {}};
  registryReads = 0;
  const result = await delegateVoiceTurnToBrain('Question publique', ctx, {
    submit: async () => ({success: true, accepted: true, submissionState: 'accepted', runId, state: 'running'}),
    status: (id) => status(id), now, sleep, ...(poll ? {pollMs: poll} : {}),
  });
  return {result, waitAfterAnswerMs: result.timing.brainMs - settleAt, reads: registryReads};
}

(async () => {
  try {
    // 1. A followed running run is answered from memory: no registry read, same state as getRunStatus.
    const {runId, observer} = await followed('memory');
    assert.equal(runs.followedRunStillRunning(runId), true);
    registryReads = 0;
    for (let i = 0; i < 50; i++) assert.equal((await runs.voiceRunStatus(runId)).state, 'running');
    assert.equal(registryReads, 0, '50 voice polls, no runs.json read');
    const full = await runs.getRunStatus(runId);
    assert.equal(full.state, 'running');
    assert(registryReads >= 2, 'the full status parses runs.json (twice) per poll');
    // Terminal: the full path, with the verified text.
    await observer.final(terminal(runId));
    assert.equal(runs.followedRunStillRunning(runId), false);
    const done = await runs.voiceRunStatus(runId);
    assert.equal(done.state, 'done'); assert.equal(done.result, 'Réponse publique.');
    // Unknown run and expired observation take the full path (reconciliation stays the owner's).
    assert.equal(runs.followedRunStillRunning('run_unknown'), false);
    const late = await followed('expired');
    assert.equal(runs.followedRunStillRunning(late.runId, Date.now() + 121_000), false);

    // 2. Voice turns settling at the captured S24 instants (accepted → terminal).
    const settleInstants = [
      terminalTiming.metrics.terminalRpcLoggedAt - terminalTiming.metrics.acceptedAt,
      Math.round((voiceCapture.metrics.brain_done - voiceCapture.metrics.brain_run_accepted) * 1000),
      6230,
    ];
    assert.equal(VOICE_BRAIN_POLL_MS, 500);
    const rows = [];
    for (const settleAt of settleInstants) {
      const before = await voiceTurn(settleAt, undefined, runs.getRunStatus);
      const after = await voiceTurn(settleAt, 100, runs.voiceRunStatus);
      assert.equal(before.result.state, 'done'); assert.equal(after.result.state, 'done');
      assert.equal(after.result.text, 'Réponse publique.');
      assert(after.waitAfterAnswerMs >= 0 && after.waitAfterAnswerMs < 100, `wait ${after.waitAfterAnswerMs}`);
      assert(before.waitAfterAnswerMs >= 0 && before.waitAfterAnswerMs < 500);
      assert(after.reads <= 4, `only the terminal read (${after.reads})`);
      assert(before.reads > after.reads, 'the previous poll read the registry on every tick');
      rows.push({settleAt, waitBefore: before.waitAfterAnswerMs, waitAfter: after.waitAfterAnswerMs, readsBefore: before.reads, readsAfter: after.reads});
    }

    // 3. The voice capability route uses this status and poll (server owner).
    const server = fs.readFileSync(path.join(__dirname, '../src/companion/server.ts'), 'utf8');
    assert.match(server, /submit: submitIntent, status: voiceRunStatus, pollMs: VOICE_RUN_POLL_MS,/);
    assert.match(server, /const VOICE_RUN_POLL_MS = 100;/);
    console.log(JSON.stringify({ok: true, rows}));
  } finally {
    fs.promises.readFile = originalRead;
    fs.rmSync(home, {recursive: true, force: true});
  }
})().catch((error) => { console.error(error); process.exit(1); });
