// O9 (fichier 37) : un run voix au transcript final ne reste jamais state=unknown.
// Source réelle : fixtures/s24-2026-10-11/o9-voice-unknown-runs.json (3 runs du registre runs.json du S24,
// identifiants pseudonymisés, longueurs seules ; aucun texte, transcription ni audio).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9-voice-"));
process.env.OPENCLAW_STATE_DIR = root;
const capture = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/s24-2026-10-11/o9-voice-unknown-runs.json"), "utf8"));
const runs = require("../dist/companion/runs.js");

function storedFromCapture(row) {
  // Same keys as fields_present in the capture; text lengths preserved, content replaced by neutral filler.
  const input = "x".repeat(row.input_chars), output = "y".repeat(row.output_chars);
  const stored = {runId: row.runId, sessionId: row.sessionId, modality: row.modality, state: row.state,
    transcriptState: row.transcriptState, transcriptRevision: row.transcriptRevision, acceptedAt: row.acceptedAt,
    updatedAt: row.updatedAt, text: input, userText: input, result: output};
  assert.deepEqual(Object.keys(stored).sort(), [...row.fields_present].sort());
  return stored;
}

async function main() {
  assert.equal(capture.runs.length, 3);
  for (const row of capture.runs) {
    assert.equal(row.state, "unknown");
    assert.equal(row.transcriptState, "interrupted");
  }
  const file = path.join(root, "clawmobile-companion", "runs.json");
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const seeded = capture.runs.map(storedFromCapture);
  fs.writeFileSync(file, JSON.stringify({version: 1, runs: seeded, archivedSessionIds: [], paymentRequests: [],
    ownerConfirmations: [], runDeletions: []}));

  // Read path (GET /runs and GET /runs/{id}): reconciled without any write.
  const listed = await runs.listRuns({limit: 50});
  assert.equal(listed.length, 3);
  for (const status of listed) {
    assert.notEqual(status.state, "unknown", status.runId);
    assert.equal(status.state, "done");
    assert.equal(status.status, "interrupted");
    assert.equal(status.transcriptState, "interrupted");
    assert.equal(status.modality, "voice");
  }
  for (const row of capture.runs) {
    const status = await runs.getRunStatus(row.runId);
    assert.equal(status.state, "done");
    assert.equal(status.result.length, row.output_chars, "transcript kept as is");
  }

  // Owner write path (POST /sessions/{id}/voice-turns -> saveVoiceTurn).
  const session = "sess-o9-test";
  const interrupted = await runs.saveVoiceTurn(session, {runId: "voice-00000000-0000-4000-8000-000000000001",
    revision: 2, input: "x".repeat(28), output: "", state: "interrupted"});
  assert.equal(interrupted.state, "done");
  assert.equal(interrupted.status, "interrupted");
  const completed = await runs.saveVoiceTurn(session, {runId: "voice-00000000-0000-4000-8000-000000000002",
    revision: 1, input: "x", output: "y", state: "completed"});
  assert.equal(completed.state, "done");
  assert.equal(completed.status, undefined);
  const partial = await runs.saveVoiceTurn(session, {runId: "voice-00000000-0000-4000-8000-000000000003",
    revision: 1, input: "x", output: "", state: "partial"});
  assert.equal(partial.state, "unknown", "a partial transcript is not terminal");

  // The write persisted the reconciliation of the three captured runs: none left unknown with a final transcript.
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  const terminalUnknown = store.runs.filter(run => run.modality === "voice" && run.state === "unknown"
    && ["completed", "interrupted"].includes(run.transcriptState));
  assert.deepEqual(terminalUnknown, []);
  for (const row of capture.runs) {
    const persisted = store.runs.find(run => run.runId === row.runId);
    assert.equal(persisted.state, "done");
    assert.equal(persisted.transcriptState, "interrupted");
    assert.equal(persisted.acceptedAt, row.acceptedAt);
  }
  // A final turn stays final (existing guard), the reconciliation does not reopen it.
  await assert.rejects(runs.saveVoiceTurn(session, {runId: "voice-00000000-0000-4000-8000-000000000002",
    revision: 3, input: "x", output: "z", state: "partial"}), /turn_already_final/);
  console.log("O9 voice runs terminal: PASS (3 captured S24 runs reconciled, interrupted -> done/interrupted)");
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, {recursive: true, force: true}));
