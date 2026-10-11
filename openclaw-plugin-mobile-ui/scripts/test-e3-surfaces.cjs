// 38 E3 / T5 — WhatsApp (inbound_claim), voice relay and Gemini Live share the app's CLARIFY contract:
// run 1 = question, answer through resolve-clarification (never concatenated), then the handoff;
// run 2 (learned) = handoff directly, zero question, zero agent/Gateway call.
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
process.env.CLAW_VOICE_RELAY_CONFIG = path.join(os.tmpdir(), "e3-voice-relay-missing.json");

const { SurfaceClarifications } = require("../dist/capabilityClarification.js");
const fastPath = require("../dist/modelFastPath.js");
const voice = require("../dist/companion/voiceRelay.js");
const live = require("../dist/companion/clawLive.js");

const ORIGINAL = "recharge orange 5 dt";
const CLARIFY = { version: 2, type: "CLARIFY", risk: "transaction", target: "maxit-tunisie", clarification: { question: "Recharge payante de 5 DT sur ta ligne Orange, ou consulter ton solde de recharge ?", choices: [{ intent: "telecom.recharge", label: "recharge payante de 5 DT", risk: "transaction" }, { intent: "telecom.balance", label: "consulter ton solde de recharge", risk: "read" }] } };
const EXECUTE = { version: 2, type: "EXECUTE", risk: "transaction", target: "maxit-tunisie", confirmationRequired: true };

/** Fake canonical fast path. `learned` flips after one resolved clarification (A1 learning by the graph). */
function fakeRunner() {
  const calls = [];
  let learned = false;
  const runner = async (message, options = {}) => {
    calls.push({ message, ...options });
    if (options.clarificationDecision) {
      assert.equal(options.clarificationOriginalText, ORIGINAL, "resolve-clarification receives the original text");
      assert.equal(message.includes("Précision utilisateur"), false);
      if (/premi|recharge payante/i.test(message)) {
        learned = true;
        return { status: "eligible", decision: EXECUTE, resolution: { text: "recharge payante de 5 DT sur ma ligne Orange", decision: EXECUTE } };
      }
      return { status: "clarification_unrelated", reason: "new_topic" };
    }
    if (options.preparedDecision) {
      assert.deepEqual(options.preparedDecision, EXECUTE);
      return { status: "hit", text: "Carte de confirmation ouverte : recharge 5 DT Orange (biométrie requise).", result: { ok: true, text: "Carte de confirmation ouverte : recharge 5 DT Orange (biométrie requise)." }, decision: EXECUTE };
    }
    if (message === ORIGINAL) {
      if (learned) return options.checkOnly ? { status: "eligible", decision: EXECUTE } : { status: "hit", text: "Carte de confirmation ouverte : recharge 5 DT Orange (biométrie requise).", decision: EXECUTE };
      return { status: "clarification", text: CLARIFY.clarification.question, clarification: CLARIFY.clarification, decision: CLARIFY };
    }
    return { status: "miss", reason: "model_allowed", decision: { type: "REASON", risk: "read" } };
  };
  return { runner, calls };
}

async function main() {
  let checks = 0;

  // --- WhatsApp: inbound_claim ---
  {
    const { runner, calls } = fakeRunner();
    const clar = new SurfaceClarifications(runner);
    const event = (content) => ({ content, senderIsOwner: true, isGroup: false, sessionKey: "agent:main:whatsapp:direct:21600000000" });
    const ctx = { agentId: "main", channel: "whatsapp", sessionKey: "agent:main:whatsapp:direct:21600000000" };
    const r1 = await fastPath.handleOwnerFastPath(event(ORIGINAL), ctx, runner, clar);
    assert.deepEqual(r1, { handled: true, reply: { text: CLARIFY.clarification.question } }); checks++;
    const r2 = await fastPath.handleOwnerFastPath(event("la première"), ctx, runner, clar);
    assert.equal(r2.handled, true); assert.match(r2.reply.text, /Carte de confirmation/); checks += 2;
    assert.ok(calls.some((c) => c.clarificationDecision && c.message === "la première" && c.surface === "whatsapp")); checks++;
    const before = calls.length;
    const r3 = await fastPath.handleOwnerFastPath(event(ORIGINAL), ctx, runner, clar);
    assert.match(r3.reply.text, /Carte de confirmation/); checks++;
    assert.equal(calls.slice(before).some((c) => c.clarificationDecision), false, "run 2: zero question"); checks++;
    // Another WhatsApp conversation does not inherit the pending question.
    const other = { ...ctx, sessionKey: "agent:main:whatsapp:direct:21611111111" };
    await fastPath.handleOwnerFastPath({ ...event("bonjour"), sessionKey: other.sessionKey }, other, runner, clar);
    assert.equal(calls.at(-1).clarificationDecision, undefined); checks++;
    // Unrelated answer: abandoned clarification, new request from its own text (no concatenation).
    const { runner: r, calls: c2 } = fakeRunner();
    const clar2 = new SurfaceClarifications(r);
    await fastPath.handleOwnerFastPath(event(ORIGINAL), ctx, r, clar2);
    const u = await fastPath.handleOwnerFastPath(event("quelle heure est-il"), ctx, r, clar2);
    assert.equal(u.handled, false); assert.equal(c2.at(-1).message, "quelle heure est-il"); assert.equal(c2.at(-1).checkOnly, true); checks += 3;
  }

  // --- Voice relay ---
  {
    const { runner, calls } = fakeRunner();
    voice.voiceRelayTurnsForTest.useClarifications(new SurfaceClarifications(runner));
    const q = await voice.voiceRelayTurnsForTest.request("req-1", ORIGINAL);
    assert.equal(q.state, "needs_clarification"); assert.equal(q.source, "capability"); assert.equal(q.question, CLARIFY.clarification.question); assert.equal(q.choices.length, 2); checks += 4;
    const done = await voice.voiceRelayTurnsForTest.continuation("req-2", q.conversationId, "la première");
    assert.equal(done.state, "done"); assert.equal(done.source, "capability"); assert.match(done.text, /Carte de confirmation/); checks += 3;
    assert.ok(calls.every((c) => !String(c.message).includes("Précision utilisateur"))); checks++;
    assert.ok(calls.every((c) => c.surface === "bixby_claw")); checks++;
    const before = calls.length;
    const run2 = await voice.voiceRelayTurnsForTest.request("req-3", ORIGINAL);
    assert.equal(run2.state, "done"); assert.match(run2.text, /Carte de confirmation/); checks += 2;
    assert.deepEqual(calls.slice(before).map((c) => c.preparedDecision ? "execute" : c.checkOnly ? "check" : "other"), ["check", "execute"]); checks++;
    const expired = await voice.voiceRelayTurnsForTest.continuation("req-4", q.conversationId, "la première");
    assert.equal(expired.error, "conversation_expired"); checks++;
  }

  // --- Gemini Live ---
  {
    const { runner, calls } = fakeRunner();
    const clar = new SurfaceClarifications(runner);
    const executed = [];
    const exec = async (text) => { executed.push(text); return { success: true, execution: { state: "completed" } }; };
    const q = await live.clawLiveCapabilityTurn({ request: ORIGINAL }, exec, clar);
    assert.equal(q.state, "needs_clarification"); assert.match(q.clarificationId, /^clar-[a-f0-9]{24}$/); assert.equal(q.execution.state, "needs_clarification"); checks += 3;
    const done = await live.clawLiveCapabilityTurn({ request: "la première", clarificationId: q.clarificationId }, exec, clar);
    assert.equal(done.state, "done"); assert.match(done.text, /Carte de confirmation/); checks += 2;
    assert.deepEqual(executed, [], "transaction never reaches the plain executor or the agent"); checks++;
    const before = calls.length;
    const run2 = await live.clawLiveCapabilityTurn({ request: ORIGINAL }, exec, clar);
    assert.equal(run2.state, "done"); assert.equal(calls.slice(before).some((c) => c.clarificationDecision), false); checks += 2;
    // Plain reads keep the existing executor, on the ORIGINAL text.
    await live.clawLiveCapabilityTurn({ request: "quelle heure est-il" }, exec, clar);
    assert.deepEqual(executed, ["quelle heure est-il"]); checks++;
    // Android v2 has no clarificationId: a session-scoped id carries the question to the next turn.
    const sid = SurfaceClarifications.idFor("claw-live:epoch-7");
    const { runner: r2 } = fakeRunner(); const clar2 = new SurfaceClarifications(r2);
    const a1 = await live.clawLiveCapabilityTurn({ request: ORIGINAL, clarificationId: sid }, exec, clar2);
    assert.equal(a1.clarificationId, sid); checks++;
    const a2 = await live.clawLiveCapabilityTurn({ request: "la première", clarificationId: sid }, exec, clar2);
    assert.equal(a2.state, "done"); checks++;
    // Setup and browser page carry the clarification contract and the original transcription.
    const setup = live.buildClawLiveSetup("gemini-3.8-live", { home: os.tmpdir() }).setup;
    const decl = setup.tools[0].functionDeclarations[0];
    assert.ok(decl.parameters.properties.clarificationId); assert.deepEqual(decl.parameters.required, ["request"]); checks += 2;
    assert.match(setup.systemInstruction.parts[0].text, /needs_clarification, read its question aloud verbatim/); checks++;
    const html = live.clawLivePageHtml();
    assert.match(html, /request:original\|\|String\(args\?\.request/); assert.match(html, /heard\+=sc\.inputTranscription\.text/); checks += 2;
  }

  // --- Bounds ---
  {
    let now = 0; const { runner } = fakeRunner();
    const clar = new SurfaceClarifications(runner, () => now);
    const q = await clar.turn(ORIGINAL, { surface: "claw_live", originId: "t" });
    assert.equal(clar.hasPending(q.clarificationId), true); now += 10 * 60_000 + 1;
    assert.equal(clar.hasPending(q.clarificationId), false); checks += 2;
    now = 0; for (let i = 0; i < 80; i++) clar.hold(SurfaceClarifications.idFor("k" + i), ORIGINAL, CLARIFY, "whatsapp");
    assert.equal(clar.size(), 64); checks++;
    assert.equal(clar.hold("bad-id", ORIGINAL, CLARIFY, "whatsapp"), false); assert.equal(clar.hold(SurfaceClarifications.idFor("x"), ORIGINAL, EXECUTE, "whatsapp"), false); checks += 2;
  }

  console.log(`E3 surfaces (T5 app-equivalent on WhatsApp, voice relay, Gemini Live): ${checks} checks passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
