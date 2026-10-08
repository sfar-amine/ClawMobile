const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "samantha-submit-reconcile-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "openclaw-state");
process.env.CLAWMOBILE_AGENT_ID = "main";
const helper = path.join(root, "model-fast-path.py");
const helperLog = path.join(root, "model-fast-path.log");
fs.writeFileSync(helper, [
  "import json, os, sys",
  "mode = 'check' if '--check' in sys.argv else 'execute'",
  "message = sys.argv[-1] if sys.argv else ''",
  "with open(os.environ['CLAWMOBILE_TEST_FAST_PATH_LOG'], 'a', encoding='utf-8') as h: h.write(mode + '\\n')",
  "if 'ambiguous capability' in message:",
  " print(json.dumps({'status':'clarification','text':'Tu veux consulter ou agir ?','model_bypassed':True}))",
  "else:",
  " print(json.dumps({'status':'eligible','model_bypassed':True} if mode == 'check' else {'status':'hit','text':'CAPABILITY_FIRST_DIRECT_OK','model_bypassed':True}))",
  "",
].join("\n"));
process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER = helper;
process.env.CLAWMOBILE_TEST_FAST_PATH_LOG = helperLog;

const {
  findSubmittedRunByClientRunId,
  getConversationTurns,
  getRunStatus,
  getRunStatusByClientRunId,
  listRuns,
  reserveSubmittedRun,
} = require("../dist/companion/runs.js");
const { notSubmitted, submitIntent } = require("../dist/companion/intent.js");
const { runSubmissionStatusCode } = require("../dist/companion/server.js");

(async () => {
  const text = "known owner capability";
  const sessionId = "session-submit-reconcile";
  const clientRunId = "samantha-215eec1e-c749-4ecc-b70b-193cb52d85fa";
  const options = { userText: text, attachments: [], requestText: text };

  const first = await reserveSubmittedRun("enriched prompt", sessionId, clientRunId, options);
  assert.equal(first.created, true);
  assert.equal(first.status.clientRunId, clientRunId);
  assert.equal(first.status.state, "running");
  assert.match(first.status.runId, /^run_[0-9]+_[a-f0-9]{8}$/);

  const duplicate = await reserveSubmittedRun("enriched prompt regenerated", sessionId, clientRunId, options);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.status.runId, first.status.runId);

  const concurrentClientRunId = "samantha-315eec1e-c749-4ecc-b70b-193cb52d85fa";
  const concurrent = await Promise.all(Array.from({ length: 12 }, () =>
    reserveSubmittedRun("same enriched prompt", sessionId, concurrentClientRunId, {
      userText: text, attachments: [], requestText: text,
    }),
  ));
  assert.equal(concurrent.filter((item) => item.created).length, 1);
  assert.equal(new Set(concurrent.map((item) => item.status.runId)).size, 1);

  const found = await findSubmittedRunByClientRunId(clientRunId);
  assert.ok(found);
  assert.equal(found.runId, first.status.runId);
  const status = await getRunStatusByClientRunId(clientRunId);
  assert.equal(status.runId, first.status.runId);
  assert.equal(status.clientRunId, clientRunId);

  await assert.rejects(
    reserveSubmittedRun("different prompt", sessionId, clientRunId, { userText: "different request", requestText: "different request" }),
    (error) => error && error.message === "client_run_identity_conflict" && error.statusCode === 409,
  );

  const registry = JSON.parse(fs.readFileSync(
    path.join(process.env.OPENCLAW_STATE_DIR, "clawmobile-companion", "runs.json"),
    "utf8",
  ));
  const persisted = registry.runs.find((run) => run.clientRunId === clientRunId);
  assert.ok(persisted);
  assert.equal(persisted.runId, first.status.runId);
  assert.match(persisted.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(persisted.executionSource, "gateway");

  const directClientRunId = "samantha-415eec1e-c749-4ecc-b70b-193cb52d85fa";
  const direct = await submitIntent("known direct capability", "session-direct-capability", [], {
    userText: "known direct capability", clientRunId: directClientRunId,
  });
  assert.equal(direct.success, true);
  assert.equal(direct.accepted, true);
  assert.equal(direct.state, "done");
  assert.equal(direct.result, "CAPABILITY_FIRST_DIRECT_OK");
  const directStatus = await getRunStatusByClientRunId(directClientRunId);
  assert.equal(directStatus.state, "done");
  assert.equal(directStatus.result, "CAPABILITY_FIRST_DIRECT_OK");
  assert.equal(directStatus.message, "CAPABILITY_FIRST_DIRECT_OK");
  assert.equal(directStatus.progress.text, "Completed.");

  const directRegistry = JSON.parse(fs.readFileSync(
    path.join(process.env.OPENCLAW_STATE_DIR, "clawmobile-companion", "runs.json"),
    "utf8",
  ));
  const directStored = directRegistry.runs.find((run) => run.clientRunId === directClientRunId);
  assert.equal(directStored.executionSource, "capability_first");

  // A shared historical model session may contain the same request text. It must
  // never enrich or overwrite a local Capability-First result.
  const sessionsDir = path.join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const modelSessionId = "old-model-session";
  fs.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify({ sessions: [{
    sessionId: modelSessionId,
    key: "agent:main:companion-chat-session-direct-capability",
    label: "ClawMobile Companion",
    status: "completed",
    startedAt: 10,
    endedAt: 20,
  }] }));
  const line = (role, content, stopReason) => JSON.stringify({
    type: "message",
    timestamp: "2026-10-08T00:00:00.000Z",
    message: { role, content, stopReason, timestamp: 10 },
  });
  fs.writeFileSync(path.join(sessionsDir, `${modelSessionId}.jsonl`), [
    line("user", "known direct capability"),
    line("assistant", "STALE_MODEL_RESULT", "stop"),
  ].join("\n"));
  const directByRun = await getRunStatus(direct.runId);
  assert.equal(directByRun.result, "CAPABILITY_FIRST_DIRECT_OK");
  const directTurns = await getConversationTurns("session-direct-capability");
  assert.equal(directTurns.find((run) => run.runId === direct.runId).result, "CAPABILITY_FIRST_DIRECT_OK");
  const directList = await listRuns({ limit: 20 });
  assert.equal(directList.find((run) => run.runId === direct.runId).result, "CAPABILITY_FIRST_DIRECT_OK");
  const afterEnrichmentAttempt = JSON.parse(fs.readFileSync(
    path.join(process.env.OPENCLAW_STATE_DIR, "clawmobile-companion", "runs.json"),
    "utf8",
  )).runs.find((run) => run.runId === direct.runId);
  assert.equal(afterEnrichmentAttempt.result, "CAPABILITY_FIRST_DIRECT_OK");
  const callsAfterFirst = fs.readFileSync(helperLog, "utf8").trim().split(/\s+/);
  assert.deepEqual(callsAfterFirst, ["check", "execute"]);
  const directDuplicate = await submitIntent("known direct capability", "session-direct-capability", [], {
    userText: "known direct capability", clientRunId: directClientRunId,
  });
  assert.equal(directDuplicate.duplicate, true);
  assert.equal(directDuplicate.runId, direct.runId);
  assert.deepEqual(fs.readFileSync(helperLog, "utf8").trim().split(/\s+/), callsAfterFirst);

  const clarificationClientRunId = "samantha-515eec1e-c749-4ecc-b70b-193cb52d85fa";
  const clarification = await submitIntent("ambiguous capability", "session-clarification", [], {
    userText: "ambiguous capability", clientRunId: clarificationClientRunId,
  });
  assert.equal(clarification.accepted, true);
  assert.equal(clarification.state, "done");
  assert.equal(clarification.result, "Tu veux consulter ou agir ?");
  const clarificationStored = await getRunStatusByClientRunId(clarificationClientRunId);
  assert.equal(clarificationStored.state, "done");
  assert.equal(clarificationStored.result, "Tu veux consulter ou agir ?");
  assert.equal(clarificationStored.message, "Tu veux consulter ou agir ?");
  assert.equal(clarificationStored.progress.text, "Completed.");
  const clarificationRegistry = JSON.parse(fs.readFileSync(
    path.join(process.env.OPENCLAW_STATE_DIR, "clawmobile-companion", "runs.json"),
    "utf8",
  ));
  const clarificationDurable = clarificationRegistry.runs.find((run) => run.clientRunId === clarificationClientRunId);
  assert.equal(clarificationDurable.executionSource, "capability_first");
  const clarificationCalls = fs.readFileSync(helperLog, "utf8").trim().split(/\s+/);
  assert.equal(clarificationCalls.at(-1), "check");

  const rejected = notSubmitted(sessionId, clientRunId, "gateway unavailable");
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.submissionState, "not_submitted");
  assert.equal(rejected.retrySafe, true);
  assert.equal(runSubmissionStatusCode(rejected), 503);
  assert.equal(runSubmissionStatusCode({ success: true }), 200);
  assert.equal(runSubmissionStatusCode({ success: false }), 400);

  console.log(`submit reconciliation test passed: ${root}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
