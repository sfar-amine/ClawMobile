// 38 E3 / T5, migrated to SAM-MIG-CC-001 V2.2 (L5): WhatsApp (inbound_claim / before_dispatch), voice relay and
// Gemini Live are surfaces of the dialogue coordinator. The TypeScript side keeps NO dialogue state: it sends one
// admitted event (original text, conversation key, transport identity) and adapts the form of the reply. The fake
// below stands for the Python coordinator (its behaviour is tested in samantha-ui-playbooks
// tests/test_dialogue_coordinator.py); here we check what the surfaces send and how they render.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.CLAW_VOICE_RELAY_CONFIG = path.join(os.tmpdir(), "e3-voice-relay-missing.json");

const dialogue = require("../dist/dialogueSurface.js");
const fastPath = require("../dist/modelFastPath.js");
const voice = require("../dist/companion/voiceRelay.js");
const live = require("../dist/companion/clawLive.js");

const ORIGINAL = "recharge orange 5 dt";
const QUESTION = "Recharge payante de 5 DT sur ta ligne Orange, ou consulter ton solde de recharge ?";
const CHOICES = [{ label: "recharge payante de 5 DT" }, { label: "consulter ton solde de recharge" }];
const DONE = "Carte de confirmation ouverte : recharge 5 DT Orange (biométrie requise).";

/** Stand-in for the coordinator: one pending question per conversation key, owned on the "Python side". */
function fakeCoordinator() {
  const calls = [];
  const pending = new Map();
  const runner = async (message, options = {}) => {
    calls.push({ message, ...options });
    const d = options.dialogue || {};
    assert.ok(d.event, "every turn is an admitted event");
    const key = d.event.conversationKey;
    if (d.mode === "abort") { pending.delete(key); return { outcome: "DENIED", reasonCode: "admission_revoked", handled: true }; }
    if (d.mode === "handoff") return { outcome: "COMPLETED", text: DONE, handled: true, handoff: { status: "ACCEPTED", klass: "FAST" } };
    if (pending.has(key)) {
      if (/premi|recharge payante/i.test(message)) {
        pending.delete(key);
        return d.policy?.deferHandoff
          ? { outcome: "READY", pendingHandoff: { goalRef: "goal-0123456789abcdef0123", klass: "FAST" }, handled: true }
          : { outcome: "COMPLETED", text: DONE, handled: true };
      }
      return { outcome: "UNRESOLVED", text: "Je n'ai pas compris ta réponse. " + QUESTION, handled: true, modelAllowed: false, question: { version: 1, kind: "choice", text: QUESTION, choices: CHOICES } };
    }
    if (message === ORIGINAL) {
      pending.set(key, true);
      return { outcome: "NEEDS_CHOICE", text: QUESTION, handled: true, question: { version: 1, kind: "choice", text: QUESTION, choices: CHOICES } };
    }
    return { outcome: "UNRESOLVED", modelAllowed: true, handled: false };
  };
  return { runner, calls };
}

async function main() {
  let checks = 0;

  // --- WhatsApp owner (inbound_claim / before_dispatch) ---
  {
    const { runner, calls } = fakeCoordinator();
    const event = (content, id) => ({ content, senderIsOwner: true, isGroup: false, sessionKey: "agent:main:whatsapp:direct:21600000000", id });
    const ctx = (runId) => ({ agentId: "main", channel: "whatsapp", sessionKey: "agent:main:whatsapp:direct:21600000000", runId });
    const r1 = await fastPath.handleOwnerFastPath(event(ORIGINAL), ctx("wamid-1"), runner);
    assert.deepEqual(r1, { handled: true, reply: { text: QUESTION } }); checks++;
    const r2 = await fastPath.handleOwnerFastPath(event("la première"), ctx("wamid-2"), runner);
    assert.deepEqual(r2, { handled: true, reply: { text: DONE } }); checks++;
    assert.equal(calls[1].message, "la première", "the answer is sent alone, never concatenated"); checks++;
    assert.equal(calls[0].dialogue.event.conversationKey, calls[1].dialogue.event.conversationKey); checks++;
    assert.deepEqual(calls.map((c) => c.dialogue.event.eventRef), ["wamid-1", "wamid-2"]); checks++;
    // Another WhatsApp conversation does not inherit the pending question (different key).
    await fastPath.handleOwnerFastPath(event(ORIGINAL), ctx("wamid-3"), runner);
    const other = { ...ctx("wamid-4"), sessionKey: "agent:main:whatsapp:direct:21611111111" };
    const o = await fastPath.handleOwnerFastPath({ ...event("la première"), sessionKey: other.sessionKey }, other, runner);
    assert.deepEqual(o, { handled: false }); checks++;
    // A question pending: an unresolved answer stays with the coordinator, no model (T-C10).
    const u = await fastPath.handleOwnerFastPath(event("bla"), ctx("wamid-5"), runner);
    assert.equal(u.handled, true); assert.match(u.reply.text, /n'ai pas compris/); checks += 2;
  }

  // --- Voice relay ---
  {
    const { runner, calls } = fakeCoordinator();
    voice.voiceRelayTurnsForTest.useDialogue(new dialogue.DialogueSurface(runner, "voice", "bixby_claw"));
    const q = await voice.voiceRelayTurnsForTest.request("req-1", ORIGINAL);
    assert.equal(q.state, "needs_clarification"); assert.equal(q.source, "capability"); assert.equal(q.question, QUESTION); assert.equal(q.choices.length, 2); checks += 4;
    const done = await voice.voiceRelayTurnsForTest.continuation("req-2", q.conversationId, "la première");
    assert.equal(done.state, "done"); assert.equal(done.source, "capability"); assert.match(done.text, /Carte de confirmation/); checks += 3;
    assert.ok(calls.every((c) => !String(c.message).includes("Précision utilisateur"))); checks++;
    assert.ok(calls.every((c) => c.surface === "bixby_claw" && c.dialogue.event.surface === "voice")); checks++;
    assert.equal(calls[0].dialogue.event.conversationKey, calls[1].dialogue.event.conversationKey); checks++;
    const expired = await voice.voiceRelayTurnsForTest.continuation("req-4", q.conversationId, "la première");
    assert.equal(expired.error, "conversation_expired"); checks++;
  }

  // --- Gemini Live (Claw Live): admitted turns revalidate the ticket between decision and effect (doc 43) ---
  {
    const { runner, calls } = fakeCoordinator();
    const surface = new dialogue.DialogueSurface(runner, "claw_live", "claw_live");
    const executed = [];
    const exec = async (text) => { executed.push(text); return { success: true, execution: { state: "completed" } }; };
    const sid = dialogue.dialogueConversationId("claw_live", "claw-live:epoch-7");
    assert.match(sid, /^clar-[a-f0-9]{24}$/); checks++;
    const q = await live.clawLiveCapabilityTurn({ request: ORIGINAL, clarificationId: sid }, exec, surface);
    assert.equal(q.state, "needs_clarification"); assert.equal(q.clarificationId, sid); assert.equal(q.execution.state, "needs_clarification"); checks += 3;
    let current = true;
    const done = await live.clawLiveCapabilityTurn({ request: "la première", clarificationId: sid, assertCurrent: () => { if (!current) throw new Error("owner_admission_required"); } }, exec, surface);
    assert.equal(done.state, "done"); assert.match(done.text, /Carte de confirmation/); checks += 2;
    assert.deepEqual(calls.slice(-2).map((c) => c.dialogue.mode), ["turn", "handoff"], "deferred hand-off after revalidation"); checks++;
    assert.deepEqual(executed, [], "nothing reaches the plain executor or the agent"); checks++;
    // Revoked between the committed decision and the effect: aborted, never executed.
    await live.clawLiveCapabilityTurn({ request: ORIGINAL, clarificationId: sid }, exec, surface);
    let revoke = 0;
    await assert.rejects(live.clawLiveCapabilityTurn({ request: "la première", clarificationId: sid,
      assertCurrent: () => { revoke += 1; if (revoke >= 2) throw new Error("owner_admission_required"); } }, exec, surface), /owner_admission_required/);
    assert.equal(calls.at(-1).dialogue.mode, "abort"); checks++;
    // Unresolved outside a question: the existing executor keeps the ORIGINAL text.
    await live.clawLiveCapabilityTurn({ request: "quelle heure est-il" }, exec, surface);
    assert.deepEqual(executed, ["quelle heure est-il"]); checks++;
    // A forged clarificationId is ignored (fresh per-turn conversation).
    await live.clawLiveCapabilityTurn({ request: "quelle heure est-il", clarificationId: "../../x" }, exec, surface);
    assert.match(calls.at(-1).dialogue.event.conversationKey, /^clar-[a-f0-9]{24}$/); checks++;
    const setup = live.buildClawLiveSetup("gemini-3.8-live", { home: os.tmpdir() }).setup;
    const decl = setup.tools[0].functionDeclarations[0];
    assert.ok(decl.parameters.properties.clarificationId); assert.deepEqual(decl.parameters.required, ["request"]); checks += 2;
    assert.match(setup.systemInstruction.parts[0].text, /needs_clarification, read its question aloud verbatim/); checks++;
    const html = live.clawLivePageHtml();
    assert.match(html, /request:original\|\|String\(args\?\.request/); assert.match(html, /heard\+=sc\.inputTranscription\.text/); checks += 2;
  }

  // --- INV-01 / T-M04 (static): the three former authorities are gone from the sources ---
  {
    const src = path.join(__dirname, "../src");
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
    walk(src);
    const all = files.map((f) => [f, fs.readFileSync(f, "utf8")]);
    assert.equal(fs.existsSync(path.join(src, "capabilityClarification.ts")), false); checks++;
    for (const [file, text] of all) {
      assert.doesNotMatch(text, /SurfaceClarifications|findPendingClarificationRun|whatsappClarifications|clarificationDecision: pending/, file);
    }
    checks++;
    // T-O02: hook replies go back as the hook text (OpenClaw durable queue); no direct send from the plugin.
    for (const [file, text] of all) assert.doesNotMatch(text, /sendDurableMessageBatch|delivery-queue-runtime/, file);
    checks++;
    // T-B04 (core side): no surface reads or writes the coordinator's private store.
    for (const [file, text] of all) assert.doesNotMatch(text, /dialogue\.sqlite/, file);
    checks++;
    const lite = fs.readFileSync(path.join(__dirname, "prepare-lite.mjs"), "utf8");
    assert.match(lite, /capabilityClarification\.js/, "a stale dist copy of the former authority is removed at build"); checks++;
  }

  console.log(`E3 surfaces on the dialogue coordinator (WhatsApp, voice relay, Gemini Live, static INV-01): ${checks} checks passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
