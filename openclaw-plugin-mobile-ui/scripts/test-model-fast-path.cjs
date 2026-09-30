const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const mod = require("../dist/modelFastPath.js");

  assert.equal(
    mod.isOwnerFastPathEligible(
      {
        content: "mon solde maxit",
        senderIsOwner: true,
        isGroup: false,
      },
      { agentId: "main" },
    ),
    true,
  );

  assert.equal(
    mod.isOwnerFastPathEligible(
      { content: "mon solde maxit", senderIsOwner: false, isGroup: false },
      { agentId: "main" },
    ),
    false,
  );

  assert.equal(
    mod.isOwnerFastPathEligible(
      { content: "mon solde maxit", senderIsOwner: true, isGroup: true },
      { agentId: "main" },
    ),
    false,
  );

  assert.equal(
    mod.isOwnerFastPathEligible(
      { content: "mon solde maxit", senderIsOwner: true, isGroup: false },
      { agentId: "gemini" },
    ),
    false,
  );

  assert.equal(
    mod.isOwnerFastPathEligible(
      {
        content: "mon solde maxit",
        senderIsOwner: true,
        isGroup: false,
        media: [{}],
      },
      { agentId: "main" },
    ),
    false,
  );

  let calls = 0;
  const hit = await mod.handleOwnerFastPath(
    {
      content: "mon solde maxit",
      senderIsOwner: true,
      isGroup: false,
    },
    { agentId: "main" },
    async () => {
      calls += 1;
      return { status: "hit", text: "Précise : recharge / balances" };
    },
  );
  assert.deepEqual(hit, {
    handled: true,
    reply: { text: "Précise : recharge / balances" },
  });
  assert.equal(calls, 1);

  const miss = await mod.handleOwnerFastPath(
    {
      content: "question complexe",
      senderIsOwner: true,
      isGroup: false,
    },
    { agentId: "main" },
    async () => ({ status: "miss", reason: "low_confidence" }),
  );
  assert.deepEqual(miss, { handled: false });

  let untrustedCalls = 0;
  const untrusted = await mod.handleOwnerFastPath(
    {
      content: "mon solde maxit",
      senderIsOwner: false,
      isGroup: false,
    },
    { agentId: "main" },
    async () => {
      untrustedCalls += 1;
      return { status: "hit", text: "should not run" };
    },
  );
  assert.deepEqual(untrusted, { handled: false });
  assert.equal(untrustedCalls, 0);



  const tempBase = path.join(os.homedir(), ".openclaw", "tmp");
  fs.mkdirSync(tempBase, { recursive: true });
  const helperRoot = fs.mkdtempSync(path.join(tempBase, "model-fast-path-test-"));
  const helper = path.join(helperRoot, "helper.py");
  fs.writeFileSync(helper, [
    "import json",
    "print(json.dumps({'status':'hit','text':'helper-ok','target':'x','intent':'y','route':'z'}))",
    "",
  ].join("\n"));
  const helperResult = await mod.runModelFastPath("hello", { helperPath: helper });
  assert.equal(helperResult.status, "hit");
  assert.equal(helperResult.text, "helper-ok");

  console.log("model-fast-path plugin tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
