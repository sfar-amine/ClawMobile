const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const mod = require("../dist/modelFastPath.js");

  assert.equal(
    mod.isOwnerFastPathEligible(
      { content: "mon solde maxit", senderIsOwner: true, isGroup: false },
      { agentId: "main" },
    ),
    true,
  );

  assert.equal(
    mod.isTrustedLocalCompanionSession(
      {
        content: "top up maxit 5 tnd",
        senderIsOwner: false,
        isGroup: false,
        sessionKey: "agent:main:companion-chat-session-1429e381",
      },
      { agentId: "main", sessionKey: "agent:main:companion-chat-session-1429e381" },
    ),
    true,
  );

  assert.equal(
    mod.isOwnerFastPathEligible(
      {
        content: "top up maxit 5 tnd",
        senderIsOwner: false,
        isGroup: false,
        sessionKey: "agent:main:companion-chat-session-1429e381",
      },
      { agentId: "main", sessionKey: "agent:main:companion-chat-session-1429e381" },
    ),
    true,
  );

  assert.equal(
    mod.isOwnerFastPathEligible(
      {
        content: "mon solde maxit",
        senderIsOwner: false,
        isGroup: false,
        sessionKey: "agent:main:whatsapp:direct:21600000000",
      },
      { agentId: "main", sessionKey: "agent:main:whatsapp:direct:21600000000", channel: "whatsapp" },
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
      { content: "mon solde maxit", senderIsOwner: true, isGroup: false, media: [{}] },
      { agentId: "main" },
    ),
    false,
  );

  let receivedOptions = null;
  const hit = await mod.handleOwnerFastPath(
    {
      content: "active le wifi",
      senderIsOwner: true,
      isGroup: false,
      runId: "run-1",
    },
    { agentId: "main", runId: "run-1" },
    async (_message, options) => {
      receivedOptions = options;
      return { status: "hit", text: "Wi-Fi activé", model_bypassed: true };
    },
  );
  assert.deepEqual(hit, { handled: true, reply: { text: "Wi-Fi activé" } });
  assert.equal(receivedOptions.surface, "claw_live");
  assert.equal(receivedOptions.caller, "owner");
  assert.equal(receivedOptions.originId, "run-1");

  const knownError = await mod.handleOwnerFastPath(
    { content: "action connue", senderIsOwner: true, isGroup: false },
    { agentId: "main" },
    async () => ({ status: "known_error", text: "Capacité connue mais indisponible." }),
  );
  assert.deepEqual(knownError, {
    handled: true,
    reply: { text: "Capacité connue mais indisponible." },
  });

  const assist = await mod.handleOwnerFastPath(
    { content: "question complexe", senderIsOwner: true, isGroup: false },
    { agentId: "main" },
    async () => ({ status: "assist", reason: "selected_requires_model" }),
  );
  assert.deepEqual(assist, { handled: false });

  const miss = await mod.handleOwnerFastPath(
    { content: "raconte moi une histoire", senderIsOwner: true, isGroup: false },
    { agentId: "main" },
    async () => ({ status: "miss", reason: "conversation_or_unknown" }),
  );
  assert.deepEqual(miss, { handled: false });

  let untrustedCalls = 0;
  const untrusted = await mod.handleOwnerFastPath(
    {
      content: "mon solde maxit",
      senderIsOwner: false,
      isGroup: false,
      sessionKey: "agent:main:whatsapp:direct:21600000000",
    },
    { agentId: "main", sessionKey: "agent:main:whatsapp:direct:21600000000", channel: "whatsapp" },
    async () => {
      untrustedCalls += 1;
      return { status: "hit", text: "should not run" };
    },
  );
  assert.deepEqual(untrusted, { handled: false });
  assert.equal(untrustedCalls, 0);

  const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capability-first-test-"));
  const helper = path.join(helperRoot, "helper.py");
  fs.writeFileSync(helper, [
    "import json,sys",
    "print(json.dumps({'status':'hit','text':'helper-ok','argv':sys.argv[1:]}))",
    "",
  ].join("\n"));
  const helperResult = await mod.runModelFastPath("hello", {
    helperPath: helper,
    surface: "claw_live",
    caller: "owner",
    originId: "run-helper",
    timeoutSeconds: 10,
  });
  assert.equal(helperResult.status, "hit");
  assert.equal(helperResult.text, "helper-ok");
  assert.deepEqual(helperResult.argv, [
    "--surface", "claw_live",
    "--caller", "owner",
    "--origin-id", "run-helper",
    "--timeout", "10",
    "hello",
  ]);
  fs.rmSync(helperRoot, { recursive: true, force: true });

  console.log("capability-first plugin tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
