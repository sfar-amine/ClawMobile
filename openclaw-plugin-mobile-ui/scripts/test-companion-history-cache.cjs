const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawmobile-history-cache-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "openclaw-state");
process.env.CLAWMOBILE_AGENT_ID = "main";
const registryDir = path.join(process.env.OPENCLAW_STATE_DIR, "clawmobile-companion");
fs.mkdirSync(registryDir, { recursive: true });

const sessionId = "samantha-cache-session";
const runId = "run-cache-1";
fs.writeFileSync(path.join(registryDir, "runs.json"), JSON.stringify({
  version: 1,
  archivedSessionIds: [],
  paymentRequests: [],
  ownerConfirmations: [],
  runs: [{
    runId,
    sessionId,
    text: "Cache question",
    userText: "Cache question",
    acceptedAt: 1000,
    state: "running"
  }]
}, null, 2));

const calls = path.join(root, "gateway-calls.txt");
const fake = path.join(root, "fake-openclaw.sh");
fs.writeFileSync(fake, `#!/bin/sh
echo call >> "${calls}"
cat <<'JSON'
{"messages":[{"role":"user","content":[{"type":"text","text":"Cache question"}],"timestamp":2000},{"role":"assistant","content":[{"type":"text","text":"Cached answer"}],"timestamp":3000}]}
JSON
`);
fs.chmodSync(fake, 0o700);
process.env.CLAWMOBILE_OPENCLAW_BIN = fake;

const { listRunSummaries, getConversationTurns } = require("../dist/companion/runs.js");

(async () => {
  const summaries = await listRunSummaries({ limit: 40 });
  assert.strictEqual(summaries.length, 1);
  assert.strictEqual(summaries[0].runId, runId);
  assert.strictEqual(fs.existsSync(calls), false, "summary path must not call OpenClaw Gateway");

  const first = await getConversationTurns(sessionId);
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].result, "Cached answer");
  assert.strictEqual(first[0].state, "done");
  assert.strictEqual(fs.readFileSync(calls, "utf8").trim().split(/\n/).length, 1);

  const persisted = JSON.parse(fs.readFileSync(path.join(registryDir, "runs.json"), "utf8"));
  assert.strictEqual(persisted.runs[0].result, "Cached answer");
  assert.strictEqual(persisted.runs[0].state, "done");

  const second = await getConversationTurns(sessionId);
  assert.strictEqual(second[0].result, "Cached answer");
  assert.strictEqual(fs.readFileSync(calls, "utf8").trim().split(/\n/).length, 1,
    "backfilled terminal result must avoid a second chat.history call");

  console.log(`companion history cache test passed: ${root}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
