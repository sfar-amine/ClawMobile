const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "samantha-submit-reconcile-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "openclaw-state");
process.env.CLAWMOBILE_AGENT_ID = "main";

const {
  findSubmittedRunByClientRunId,
  getRunStatusByClientRunId,
  reserveSubmittedRun,
} = require("../dist/companion/runs.js");
const { notSubmitted } = require("../dist/companion/intent.js");
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
