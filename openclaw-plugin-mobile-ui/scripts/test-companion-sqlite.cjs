const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "samantha-sqlite-runs-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.CLAWMOBILE_AGENT_ID = "main";
const client = require("../dist/companion/openclawAgentClient.js");
const key = "agent:main:companion-chat-sqlite-test";
let histories = 0;
client.callOpenClawGateway = async (method, params) => {
  if(method === "sessions.list") {
    assert.strictEqual(params.search, "companion-");
    return { sessions: [{ key, sessionId: "sqlite-session", status: "completed", updatedAt: 3000 }] };
  }
  assert.strictEqual(method, "chat.history");
  assert.strictEqual(params.sessionKey, key);
  histories++;
  return { messages: [
    {role:"user", content:[{type:"text",text:"Read the test value."}], timestamp:1000},
    {role:"assistant", content:[{type:"text",text:"Test value is 42."}], timestamp:2000, stopReason:"stop"}
  ] };
};
const runs = require("../dist/companion/runs.js");
(async () => {
  await runs.rememberSubmittedRun("Read the test value.", {
    runId:"run_sqlite_test", sessionId:"sqlite-test", sessionKey:key, acceptedAt:1000, waitedForFinal:false,raw:{}
  }, {userText:"Read the test value."});
  let listed = await runs.listRuns();
  assert.strictEqual(listed.length,1);
  assert.strictEqual(listed[0].state,"running"); // No false completion from a previous session snapshot.
  assert.strictEqual(histories,0); // No N+1 history calls on list.
  let run = await runs.getRunStatus("run_sqlite_test");
  assert.strictEqual(run.state,"done");
  assert.strictEqual(run.result,"Test value is 42.");
  assert.strictEqual(histories,1);
  listed = await runs.listRuns();
  assert.strictEqual(listed[0].state,"done");
  assert.strictEqual(histories,1);
  const index=path.join(root,"agents/main/sessions/sessions.json");
  fs.mkdirSync(path.dirname(index),{recursive:true});fs.writeFileSync(index,"corrupt");
  await assert.rejects(runs.listRuns()); // Corruption is not disguised as a migrated/empty store.
  fs.rmSync(root,{recursive:true,force:true});
  console.log("SQLite compatibility: 7 assertions passed; legacy store corruption preserved.");
})().catch(error=>{console.error(error);process.exit(1)});
