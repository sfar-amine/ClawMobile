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

  // S24 12/10: inbound_claim never fires for an ordinary WhatsApp DM; the owner's turns go through before_dispatch,
  // proved by the routed main session AND commands.ownerAllowFrom. WhatsApp only (app turns run in the Companion).
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-cfg-"));
  const cfgPath = path.join(cfgDir, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ commands: { ownerAllowFrom: ["whatsapp:+21610000001", "slack:U1", "+21699"] } }));
  assert.deepEqual([...mod.ownerWhatsAppNumbers(cfgPath)], ["+21610000001"]);
  assert.deepEqual([...mod.ownerWhatsAppNumbers(path.join(cfgDir, "missing.json"))], []);
  const owners = () => mod.ownerWhatsAppNumbers(cfgPath);
  const ownerKey = "agent:main:whatsapp:direct:+21610000001";
  const seen = [];
  const ownerHit = async (message, options) => { seen.push({ message, ...options }); return { status: "hit", text: "Solde Orange : 12,500 DT" }; };
  assert.deepEqual(await mod.handleOwnerBeforeDispatch(
    { messageId: "3EB0OWN", content: "mon solde orange", body: "[WhatsApp +21610000001 +1s] +21610000001: mon solde orange", channel: "whatsapp", sessionKey: ownerKey },
    { channelId: "whatsapp", sessionKey: ownerKey }, ownerHit, owners), { handled: true, text: "Solde Orange : 12,500 DT" });
  assert.equal(seen[0].message, "mon solde orange"); assert.equal(seen[0].caller, "owner"); assert.equal(seen[0].surface, "whatsapp");
  assert.equal(seen[0].originId, "3EB0OWN");
  const never = async () => { throw new Error("must not run"); };
  for (const [event, label] of [
    [{ content: "mon solde orange", channel: "whatsapp", sessionKey: "agent:main:whatsapp:direct:+21610000009" }, "main session, number not an owner"],
    [{ content: "mon solde orange", channel: "whatsapp", sessionKey: "agent:contacts:whatsapp:direct:+21610000001" }, "contacts agent"],
    [{ content: "mon solde orange", channel: "whatsapp", sessionKey: ownerKey, isGroup: true }, "group"],
    [{ content: "mon solde orange", channel: "openclaw", sessionKey: "agent:main:companion-chat-abc" }, "app turn (Companion already ran it)"],
  ]) assert.deepEqual(await mod.handleOwnerBeforeDispatch(event, { sessionKey: event.sessionKey }, never, owners), { handled: false }, label);
  // A miss stays with the agent (unchanged owner behaviour).
  assert.deepEqual(await mod.handleOwnerBeforeDispatch({ content: "écris un poème", channel: "whatsapp", sessionKey: ownerKey }, { sessionKey: ownerKey },
    async () => ({ status: "miss", reason: "model_allowed" }), owners), { handled: false });
  const indexSource = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf8");
  assert.match(indexSource, /api\.on\("before_dispatch"[\s\S]{0,300}handleOwnerBeforeDispatch/);
  fs.rmSync(cfgDir, { recursive: true, force: true });

  console.log("capability-first plugin tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
