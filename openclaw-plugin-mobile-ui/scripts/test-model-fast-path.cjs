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
      return { outcome: "COMPLETED", text: "Wi-Fi activé", handled: true };
    },
  );
  assert.deepEqual(hit, { handled: true, reply: { text: "Wi-Fi activé" } });
  assert.equal(receivedOptions.surface, "claw_live");
  assert.equal(receivedOptions.caller, "owner");
  assert.equal(receivedOptions.originId, "run-1");
  // SAM-MIG V2.2: one admitted event for the dialogue coordinator, transport identity from the existing owner.
  assert.equal(receivedOptions.dialogue.mode, "turn");
  assert.equal(receivedOptions.dialogue.event.eventRef, "run-1");
  assert.equal(receivedOptions.dialogue.event.surface, "claw_live");
  assert.deepEqual(receivedOptions.dialogue.policy, { modelAllowed: true });

  const knownError = await mod.handleOwnerFastPath(
    { content: "action connue", senderIsOwner: true, isGroup: false },
    { agentId: "main" },
    async () => ({ outcome: "TECHNICAL_FAILURE", reasonCode: "capability_unavailable", text: "Capacité connue mais indisponible.", handled: true }),
  );
  assert.deepEqual(knownError, {
    handled: true,
    reply: { text: "Capacité connue mais indisponible." },
  });

  const assist = await mod.handleOwnerFastPath(
    { content: "question complexe", senderIsOwner: true, isGroup: false },
    { agentId: "main" },
    async () => ({ outcome: "UNRESOLVED", reasonCode: "selected_requires_model", modelAllowed: true, handled: false }),
  );
  assert.deepEqual(assist, { handled: false });

  const miss = await mod.handleOwnerFastPath(
    { content: "raconte moi une histoire", senderIsOwner: true, isGroup: false },
    { agentId: "main" },
    async () => ({ outcome: "UNRESOLVED", reasonCode: "model_allowed", modelAllowed: true, handled: false }),
  );
  assert.deepEqual(miss, { handled: false });

  // A pending question is answered without the model; the coordinator owns it (no local copy).
  const question = await mod.handleOwnerFastPath(
    { content: "bla", senderIsOwner: true, isGroup: false, runId: "run-q" }, { agentId: "main", runId: "run-q" },
    async () => ({ outcome: "UNRESOLVED", text: "Je n'ai pas compris ta réponse. De quelle offre parles-tu ?", modelAllowed: false, handled: true,
      question: { version: 3, kind: "input", text: "De quelle offre parles-tu ?" } }),
  );
  assert.deepEqual(question, { handled: true, reply: { text: "Je n'ai pas compris ta réponse. De quelle offre parles-tu ?" } });
  // T-X05: anything that is not a coordinator reply (legacy shape, crash) is a bounded failure, never the model.
  for (const broken of [async () => ({ status: "hit", text: "legacy" }), async () => { throw new Error("helper died"); }]) {
    const out = await mod.handleOwnerFastPath({ content: "mon solde", senderIsOwner: true, isGroup: false, runId: "run-x" }, { agentId: "main", runId: "run-x" }, broken);
    assert.equal(out.handled, true);
    assert.match(out.reply.text, /suivi de conversation de Samantha est indisponible/);
  }

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
  // --dialogue: event and policy travel base64-encoded, never on the command line.
  fs.writeFileSync(helper, [
    "import base64,json,os,sys",
    "ev=json.loads(base64.b64decode(os.environ['CLAW_DIALOGUE_EVENT_B64']))",
    "po=json.loads(base64.b64decode(os.environ['CLAW_DIALOGUE_POLICY_B64']))",
    "print(json.dumps({'outcome':'COMPLETED','text':'ok','argv':sys.argv[1:],'event':ev,'policy':po}))",
    "",
  ].join("\n"));
  const dialogueResult = await mod.runModelFastPath("bonjour", {
    helperPath: helper, surface: "whatsapp", caller: "owner", originId: "wamid-1", timeoutSeconds: 75,
    dialogue: { mode: "handoff", goalRef: "goal-0123456789abcdef0123", event: { surface: "whatsapp", conversationKey: "k", eventRef: "wamid-1" }, policy: { modelAllowed: true } },
  });
  assert.deepEqual(dialogueResult.argv, ["--dialogue", "handoff", "--goal-ref", "goal-0123456789abcdef0123", "--surface", "whatsapp", "--caller", "owner", "--origin-id", "wamid-1", "--timeout", "75", "bonjour"]);
  assert.equal(dialogueResult.event.conversationKey, "k");
  assert.deepEqual(dialogueResult.policy, { modelAllowed: true });
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
  const ownerHit = async (message, options) => { seen.push({ message, ...options }); return { outcome: "COMPLETED", text: "Solde Orange : 12,500 DT", handled: true }; };
  assert.deepEqual(await mod.handleOwnerBeforeDispatch(
    { messageId: "3EB0OWN", timestamp: 1792165616, content: "mon solde orange", body: "[WhatsApp +21610000001 +1s] +21610000001: mon solde orange", channel: "whatsapp", sessionKey: ownerKey },
    { channelId: "whatsapp", sessionKey: ownerKey }, ownerHit, owners), { handled: true, text: "Solde Orange : 12,500 DT" });
  assert.equal(seen[0].message, "mon solde orange"); assert.equal(seen[0].caller, "owner"); assert.equal(seen[0].surface, "whatsapp");
  assert.equal(seen[0].originId, "3EB0OWN");
  assert.equal(seen[0].dialogue.event.eventRef, "3EB0OWN");
  assert.equal(seen[0].dialogue.event.conversationKey, ownerKey);
  assert.equal(seen[0].dialogue.event.surface, "whatsapp");
  assert.equal(seen[0].dialogue.event.admittedAt, 1792165616000, "OpenClaw timestamp in seconds normalized to ms");
  const never = async () => { throw new Error("must not run"); };
  for (const [event, label] of [
    [{ content: "mon solde orange", channel: "whatsapp", sessionKey: "agent:main:whatsapp:direct:+21610000009" }, "main session, number not an owner"],
    [{ content: "mon solde orange", channel: "whatsapp", sessionKey: "agent:contacts:whatsapp:direct:+21610000001" }, "contacts agent"],
    [{ content: "mon solde orange", channel: "whatsapp", sessionKey: ownerKey, isGroup: true }, "group"],
    [{ content: "mon solde orange", channel: "openclaw", sessionKey: "agent:main:companion-chat-abc" }, "app turn (Companion already ran it)"],
  ]) assert.deepEqual(await mod.handleOwnerBeforeDispatch(event, { sessionKey: event.sessionKey }, never, owners), { handled: false }, label);
  // A miss stays with the agent (unchanged owner behaviour).
  assert.deepEqual(await mod.handleOwnerBeforeDispatch({ content: "écris un poème", channel: "whatsapp", sessionKey: ownerKey }, { sessionKey: ownerKey },
    async () => ({ outcome: "UNRESOLVED", modelAllowed: true, handled: false }), owners), { handled: false });
  const indexSource = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf8");
  assert.match(indexSource, /api\.on\("before_dispatch"[\s\S]{0,300}handleOwnerBeforeDispatch/);
  fs.rmSync(cfgDir, { recursive: true, force: true });

  console.log("capability-first plugin tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
