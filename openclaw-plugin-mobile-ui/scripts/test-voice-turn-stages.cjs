'use strict';
// Voice latency stages (S24 31/10: « merci Samantha » 6.2 s from speech end to first answer audio, no Companion
// breakdown). Replays the real S24 voice turn of 25/10 (fixtures/s24-2026-10-25-gateway-observation/native-timing.json,
// run_1792934450703_597aff20) through the exact owners: voice turn protocol marks, run registry Gateway observation
// marks, warm owner stage record. The stage record must reproduce the captured breakdown, carry no text, persist the
// brain marks with the existing terminal write only and never break the turn.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-stages-'));
process.env.OPENCLAW_STATE_DIR = home; process.env.CLAWMOBILE_AGENT_ID = 'main';
const captured = require('../fixtures/s24-2026-10-25-gateway-observation/native-timing.json');
const client = require('../dist/companion/openclawAgentClient');
client.callOpenClawGateway = async () => { throw Error('no Gateway read expected'); };
const runs = require('../dist/companion/runs');
const {VoiceTurnProtocol} = require('../dist/companion/voiceTurnProtocol');
const {ClawLiveWarmCore} = require('../dist/companion/clawLiveWarm');
const stagesModule = require('../dist/companion/voiceTurnStages');

const ms = (seconds) => Math.round(seconds * 1000);
const m = captured.metrics;
assert.equal(captured.capture.runtimeCapture, true);
const at = {pcmEnd: ms(m.pcm_end), waiting: ms(m.waiting_audible), accepted: ms(m.brain_run_accepted), started: ms(m.brain_session_started),
  model: ms(m.brain_model_completed), done: ms(m.brain_done), audio: ms(m.receipt_first_audio)};
assert.equal(at.waiting - at.pcmEnd, m.first_sign_after_pcm_ms);
assert.equal(at.audio - at.pcmEnd, m.useful_audio_after_pcm_ms);

const realNow = Date.now;
let clock = at.pcmEnd;
const sessionKey = 'agent:main:companion-chat-stages';
const registryFile = path.join(home, 'clawmobile-companion/runs.json');
const event = (runId, seq, stream, data) => ({type: 'event', event: 'agent', payload: {runId, sessionKey, seq, stream, data}});

(async () => {
  try {
    Date.now = () => clock;
    // 1. Voice turn protocol: speech end, final transcription, waiting phrase audio, capability execution.
    const forwarded = [], observed = [];
    let protocol;
    const lines = [];
    const warm = new ClawLiveWarmCore({log: (line) => lines.push(line)});
    protocol = new VoiceTurnProtocol(3, 'epoch-stages', (value) => forwarded.push(value), () => {},
      (ev, id, x = {}) => { observed.push({ev, id, x}); warm.observeTurn(ev, id, x, protocol); }, () => clock, false, undefined, false, () => clock);
    const control = (kind, extra = {}) => ({warmControl: {[kind]: {operationId: kind, sessionEpoch: 'epoch-stages', turnId: 'turn-1', ...extra}}});
    protocol.receive(control('turnStart', {firstSample: 0}));
    protocol.receive({warmInput: {audio: {sessionEpoch: 'epoch-stages', turnId: 'turn-1', firstSample: 0, samples: 1, sampleRate: 16000, data: 'AAA='}}});
    protocol.receive(control('turnEnd', {lastSampleExclusive: 1}));
    // The capture has no transcription timestamp: authored at speech end + 300 ms, asserted as given, never inferred.
    clock = at.pcmEnd + 300; protocol.receive(control('transcriptFinal', {source: 'android_speech_service', text: 'Question publique'}));
    clock = at.waiting; protocol.provider({serverContent: {modelTurn: {parts: [{inlineData: {mimeType: 'audio/pcm', data: 'AA=='}}]}}});
    protocol.provider({serverContent: {turnComplete: true}});

    // 2. The brain run through the run registry owner, with the captured clock.
    let runId, writesDuringStages = -1;
    const receipt = await protocol.execute('turn-1', 'Question publique', () => protocol.measureCapability('turn-1', async () => {
      clock = at.accepted;
      const reservation = await runs.reserveSubmittedRun('Question publique', 'stages', 'client-stages-1', {ownerAdmitted: true, userText: 'Question publique'});
      runId = reservation.status.runId;
      const observer = await runs.observeGatewayRun(runId, sessionKey);
      clock = at.accepted + 40; observer.sent();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const before = fs.readFileSync(registryFile, 'utf8');
      clock = at.started; observer.event(event(runId, 1, 'lifecycle', {phase: 'start'}));
      clock = at.model - 200; observer.event(event(runId, 2, 'assistant', {text: 'Texte privé', delta: 'Texte privé'}));
      clock = at.model - 100; observer.event(event(runId, 3, 'assistant', {text: 'Texte privé suite', delta: ' suite'}));
      await new Promise((resolve) => setTimeout(resolve, 30));
      writesDuringStages = fs.readFileSync(registryFile, 'utf8') === before ? 0 : 1;
      clock = at.done; await observer.final({runId, status: 'ok', summary: 'completed', result: {payloads: [{text: 'Réponse publique.'}], meta: {stopReason: 'stop'}}});
      const status = await runs.getRunStatus(runId);
      return {success: true, state: 'done', source: 'samantha_brain', text: status.result, runId, voice: {version: 1, phase: 'none', verbatim: status.result}};
    }));
    assert.equal(writesDuringStages, 0, 'lifecycle and assistant marks never write the registry');
    assert.equal(receipt.runId, runId);

    // Persisted with the existing terminal settlement write; text never enters the timing.
    const stored = JSON.parse(fs.readFileSync(registryFile, 'utf8')).runs.find((r) => r.runId === runId);
    const timing = stored.gatewayObservation.timing;
    assert.equal(timing.runStartedAt, at.started);
    assert.equal(timing.firstTextAt, at.model - 200, 'first assistant delta only');
    assert.equal(timing.firstToolAt, undefined);
    assert.equal(timing.terminalReceivedAt, at.done);
    assert(!JSON.stringify(stored.gatewayObservation).includes('privé'));

    // 3. Receipt read by the voice model, first receipt audio: one stage line per turn.
    protocol.receiptReply('turn-1');
    clock = at.audio; protocol.provider({serverContent: {modelTurn: {parts: [{inlineData: {mimeType: 'audio/pcm', data: 'AA=='}}]}}});
    protocol.provider({serverContent: {modelTurn: {parts: [{inlineData: {mimeType: 'audio/pcm', data: 'AA=='}}]}}});
    assert.equal(lines.length, 1, 'one record per turn, at the first receipt audio');
    const status = warm.status();
    assert.equal(status.voiceStages.length, 1);
    const record = status.voiceStages[0];
    assert.deepEqual(record, {version: 1, runId, stt_final: 300, first_audio: m.first_sign_after_pcm_ms, capability: at.waiting - at.pcmEnd,
      accepted: at.accepted - at.pcmEnd, sent: at.accepted + 40 - at.pcmEnd, run_start: at.started - at.pcmEnd, first_tool: null,
      first_text: at.model - 200 - at.pcmEnd, terminal: at.done - at.pcmEnd, settled: record.settled, capability_done: at.done - at.pcmEnd,
      receipt: at.done - at.pcmEnd, audio: m.useful_audio_after_pcm_ms, tools: null});
    assert.equal(record.settled, at.done - at.pcmEnd);
    // The captured S24 breakdown: 4 603 ms to acceptance, 21 798 ms of Gateway preparation, 22 992 ms from the brain to the first audio.
    assert.equal(record.accepted, 4603);
    assert.equal(record.run_start - record.accepted, 21798);
    assert.equal(record.audio - record.terminal, at.audio - at.done);
    assert.match(lines[0], new RegExp(`^\\[voice-stages\\] run=${runId} stt_final_ms=300 first_audio_ms=941 capability_ms=941 accepted_ms=4603 `));
    assert.match(lines[0], / first_tool_ms=- /);
    assert.match(lines[0], / audio_ms=54158 tools=-$/);
    for (const text of ['Question publique', 'Réponse publique', 'privé']) {
      assert(!lines[0].includes(text)); assert(!JSON.stringify(status).includes(text));
    }

    // 4. Tool starts are counted, bounded, and junk timing never parses.
    const tool = {};
    runs.observeRunStage(tool, 'tool', {phase: 'start', name: 'samantha_agenda', args: {secret: 1}}, 10);
    runs.observeRunStage(tool, 'tool', {phase: 'result'}, 20);
    runs.observeRunStage(tool, 'tool', {phase: 'start'}, 30);
    runs.observeRunStage(tool, 'assistant', {delta: ''}, 40);
    assert.deepEqual(tool, {firstToolAt: 10, toolStarts: 2});
    const bounded = {toolStarts: 999}; runs.observeRunStage(bounded, 'tool', {phase: 'start'}, 1);
    assert.equal(bounded.toolStarts, 999);
    assert.equal(stagesModule.voiceTurnStages({inputEndedWall: 0}, null), null);
    const noRun = stagesModule.voiceTurnStages({inputEndedWall: at.pcmEnd, runId: 'bad id with spaces', audioMs: 10}, {acceptedAt: at.accepted});
    assert.equal(noRun.runId, null); assert.equal(noRun.accepted, null, 'run marks need a valid run id');

    // 5. Instrumentation never breaks the turn: a failing run reader drops the record silently.
    const failing = new ClawLiveWarmCore({runTiming: () => { throw Error('boom'); }, log: () => { throw Error('sink down'); }});
    failing.observeTurn('t30p', 'turn-1', {phase: 1}, protocol);
    assert.equal(failing.status().voiceStages.length, 1, 'record kept even when the log sink fails');
    assert.equal(failing.status().voiceStages[0].accepted, null);
    // Bounded: the warm owner keeps the last 8 records.
    for (let i = 0; i < 12; i++) warm.observeTurn('t30p', 'turn-1', {phase: 1}, protocol);
    assert.equal(warm.status().voiceStages.length, 8);
    warm.observeTurn('t30p', 'turn-1', {phase: 0}, protocol);
    warm.observeTurn('t30p', 'unknown-turn', {phase: 1}, protocol);
    assert.equal(lines.length, 13, 'only receipt audio of a known turn records');

    console.log(JSON.stringify({ok: true, runId: captured.runId, stages: record, line: lines[0].replace(runId, '<run>')}));
  } finally {
    Date.now = realNow;
    fs.rmSync(home, {recursive: true, force: true});
  }
})().catch((error) => { console.error(error); process.exit(1); });
