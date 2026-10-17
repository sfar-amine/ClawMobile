// 17/10 : la voix en direct échouait à chaque ouverture (logcat `warm_start_failure:runtime_http_400`).
// Cause : l'accueil Android v2 (`voice-greeting-<uuid>`, sortie seule) était refusé par POST /sessions/{id}/voice-turns,
// et la file voix de l'app rejoue cet élément avant chaque démarrage. Capture : fixtures/s24-2026-10-17/voice-greeting-400.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-greeting-"));
process.env.OPENCLAW_STATE_DIR = root;
const capture = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/s24-2026-10-17/voice-greeting-400/capture.json"), "utf8"));
const runs = require("../dist/companion/runs.js");

const playback = (id, state = "playing") => ({version: 1, outputGenerationId: "out-" + id, generationState: "generating", state,
  receivedFrames: 48000, writtenFrames: 24000, playedFrames: 12000, sampleRate: 24000, clock: "audio_track_head"});

async function main() {
  // The captured failure: every voice start stops on the 400 of the voice-turn save.
  assert.ok(capture.logcat.filter(l => l.includes("warm_start_failure:runtime_http_400")).length >= 4);
  const refused = capture.replay.find(r => r.runId_shape === "voice-greeting-<uuid>");
  assert.equal(refused.status, 400);
  assert.equal(refused.error, "invalid_voice_transcript");

  const session = "samantha-00000000-0000-4000-8000-00000000c0de";
  const greeting = "voice-greeting-00000000-0000-4000-8000-000000000001";
  // Same shape as the replayed app payload: no user input, Samantha's opening output, valid playback metadata.
  const partial = await runs.saveVoiceTurn(session, {runId: greeting, revision: 1, input: "", output: "y".repeat(28),
    state: "partial", playback: playback(greeting)});
  assert.equal(partial.runId, greeting);
  assert.equal(partial.modality, "voice");
  const done = await runs.saveVoiceTurn(session, {runId: greeting, revision: 2, input: "", output: "y".repeat(40),
    state: "completed", playback: {...playback(greeting, "completed"), generationState: "completed", writtenFrames: 48000, playedFrames: 48000}});
  assert.equal(done.state, "done");
  const turns = await runs.getConversationTurns(session);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].runId, greeting);
  assert.equal(turns[0].result.length, 40);

  // The contract stays closed: only the exact app shapes are accepted.
  for (const runId of ["voice-greeting-", "voice-greetings-00000000-0000-4000-8000-000000000001",
    "voice-hello-00000000-0000-4000-8000-000000000001", "greeting-00000000-0000-4000-8000-000000000001",
    "voice-greeting-00000000-0000-4000-8000-00000000000Z"]) {
    await assert.rejects(runs.saveVoiceTurn(session, {runId, revision: 1, input: "", output: "y", state: "partial"}),
      e => e.statusCode === 400 && e.message === "invalid_voice_transcript", runId);
  }
  // An ordinary voice turn is unchanged.
  const normal = await runs.saveVoiceTurn(session, {runId: "voice-00000000-0000-4000-8000-000000000002", revision: 1,
    input: "x".repeat(19), output: "y", state: "completed"});
  assert.equal(normal.state, "done");
  console.log("voice greeting turn: ok");
}

main().catch(e => { console.error(e); process.exit(1); });
