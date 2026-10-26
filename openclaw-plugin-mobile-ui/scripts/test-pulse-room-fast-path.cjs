// Pièce « Pulse » (fichier 52 §5): a contact routed to a Pulse room agent gets the canonical capability-first
// ingress, closed to the Pulse family; everything else is refused before any execution.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const mod = require("../dist/pulseRoomFastPath.js");
const NUMBER = "+21610000003";
const KEY = `agent:contacts-pulse:whatsapp:direct:${NUMBER}`;
const CONTACT = "wa-" + crypto.createHash("sha256").update(NUMBER).digest("hex").slice(0, 16);
const ctx = (over = {}) => ({ agentId: "contacts-pulse", sessionKey: KEY, channel: "whatsapp", runId: "run-1", ...over });
const ev = (content, over = {}) => ({ content, senderIsOwner: false, isGroup: false, sessionKey: KEY, ...over });

function runner(script) {
  const calls = [];
  const fn = async (message, options = {}) => { calls.push({ message, ...options }); return script(message, options, calls.length); };
  fn.calls = calls;
  return fn;
}

async function main() {
  // Eligibility comes from the host session (room binding), never from the message.
  assert.equal(mod.pulseRoomContact(ev("x"), ctx()), CONTACT);
  assert.equal(mod.pulseRoomContact(ev("x"), ctx({ agentId: "contacts-projet-pulse", sessionKey: KEY.replace("contacts-pulse", "contacts-projet-pulse") })), CONTACT);
  assert.equal(mod.pulseRoomContact(ev("x", { sessionKey: KEY.replace("contacts-pulse", "contacts-pulse-agenda") }), ctx({ agentId: "contacts-pulse-agenda", sessionKey: KEY.replace("contacts-pulse", "contacts-pulse-agenda") })), CONTACT);
  for (const [e, c] of [
    [ev("x", { isGroup: true }), ctx()],
    [ev("x", { senderIsOwner: true }), ctx()],
    [ev("x"), ctx({ agentId: "contacts", sessionKey: `agent:contacts:whatsapp:direct:${NUMBER}` })],
    [ev("x"), ctx({ agentId: "contacts-projet", sessionKey: `agent:contacts-projet:whatsapp:direct:${NUMBER}` })],
    [ev("x"), ctx({ agentId: "main", sessionKey: `agent:main:whatsapp:direct:${NUMBER}` })],
    [ev("x"), ctx({ agentId: "contacts" })],
    [ev("x"), ctx({ channel: "slack" })],
  ]) assert.equal(mod.pulseRoomContact(e, c), null);

  // SAM-MIG V2.2: the room's closed scope is a POLICY of the dialogue coordinator (scope_verdict, tested in
  // samantha-ui-playbooks tests/test_dialogue_coordinator.py); the TypeScript verdict and its Map are removed.
  assert.equal(mod.pulseRoomVerdict, undefined);
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/pulseRoomFastPath.ts"), "utf8");
  assert.doesNotMatch(src, /new Map|clarifications\.set|CLARIFY_TTL/, "no local dialogue state in the room");

  // One admitted event per message: room scope policy, the contact named in the conversation, OpenClaw's message id.
  let r = runner(() => ({ outcome: "COMPLETED", text: "Forecast de l'offre 20447 : mai 2027 passé à 55 JH.", handled: true }));
  let out = await mod.handlePulseRoomFastPath(ev("mets le forecast de l'offre 20447 en mai 2027 à 55 JH"), ctx(), r);
  assert.deepEqual(out, { handled: true, reply: { text: "Forecast de l'offre 20447 : mai 2027 passé à 55 JH." } });
  assert.equal(r.calls.length, 1);
  const call = r.calls[0];
  assert.equal(call.caller, "owner"); assert.equal(call.surface, "whatsapp");
  assert.equal(call.dialogue.mode, "turn");
  assert.equal(call.dialogue.event.surface, "pulse_room");
  assert.equal(call.dialogue.event.eventRef, "run-1");
  assert.ok(call.dialogue.event.conversationKey.includes(CONTACT), "the requester stays visible");
  assert.deepEqual(call.dialogue.policy, { scope: "pulse_room", modelAllowed: false });

  // Outside the room, and the leave request: the coordinator refused before execution; the room gives the form.
  for (const [reply, expected] of [
    [{ outcome: "OUTSIDE_SCOPE", reasonCode: "scope_outside", handled: true }, mod.PULSE_ROOM_REFUSAL],
    [{ outcome: "DENIED", reasonCode: "scope_leave_request", handled: true }, "Une demande de congé se fait uniquement par Amine."],
  ]) {
    r = runner(() => reply);
    assert.deepEqual(await mod.handlePulseRoomFastPath(ev("x"), ctx(), r), { handled: true, reply: { text: expected } });
  }

  // Amine 12/10 « il ne faut plus inventer » : the Pulse-only room never reaches the model, even for small talk or media.
  r = runner(() => ({ outcome: "UNRESOLVED", reasonCode: "model_allowed", handled: true, modelAllowed: false }));
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("bonjour"), ctx(), r), { handled: true, reply: { text: mod.PULSE_ROOM_HELP } });
  assert.equal((await mod.handlePulseRoomFastPath(ev("", { media: [{}] }), ctx(), r)).handled, true);
  // Joint room: the room policy says when the model may answer; the coordinator applies it outside a question.
  const jointKey = KEY.replace("contacts-pulse", "contacts-projet-pulse");
  const joint = ctx({ agentId: "contacts-projet-pulse", sessionKey: jointKey });
  for (const [text, model] of [["bonjour", true], ["explique le code du Companion", true], ["où en est l'app Android de Samantha ?", true],
    ["état projet zain phase 5", false], ["comment avance le projet Zain ?", false], ["la conso de l'offre 20447", false],
    ["qui est en congé ?", false], ["Ça donne quoi le forecast", false]]) {
    r = runner((m, o) => ({ outcome: "UNRESOLVED", modelAllowed: o.dialogue.policy.modelAllowed, handled: !o.dialogue.policy.modelAllowed }));
    const got = await mod.handlePulseRoomFastPath(ev(text, { sessionKey: jointKey }), joint, r);
    assert.deepEqual(got, model ? { handled: false } : { handled: true, reply: { text: mod.PULSE_ROOM_HELP } }, text);
  }
  assert.equal(mod.pulseRoomMayUseModel("contacts-pulse", "bonjour"), false);
  // Not a room session: the runner is never called.
  r = runner(() => { throw new Error("must not run"); });
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("état du projet 20495"), ctx({ agentId: "contacts", sessionKey: `agent:contacts:whatsapp:direct:${NUMBER}` }), r), { handled: false });
  assert.equal(r.calls.length, 0);

  // A question and its answer: two events of the same conversation; the room holds nothing in between.
  r = runner((m, o, n) => n === 1 ? { outcome: "NEEDS_INPUT", text: "Quel projet ?", handled: true, question: { version: 1, kind: "input", text: "Quel projet ?" } }
    : { outcome: "COMPLETED", text: "Omniflow : en cours.", handled: true });
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("état du projet"), ctx({ runId: "m1" }), r), { handled: true, reply: { text: "Quel projet ?" } });
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("Omniflow"), ctx({ runId: "m2" }), r), { handled: true, reply: { text: "Omniflow : en cours." } });
  assert.equal(r.calls[0].dialogue.event.conversationKey, r.calls[1].dialogue.event.conversationKey);
  assert.notEqual(r.calls[0].dialogue.event.eventRef, r.calls[1].dialogue.event.eventRef);

  // before_dispatch: no agentId, no senderIsOwner; OpenClaw messageId and timestamp are the admission identity.
  const fourth = "+21610000006"; const fourthKey = `agent:contacts-projet-pulse:whatsapp:direct:${fourth}`;
  r = runner(() => ({ outcome: "COMPLETED", text: "ZAIN BAHRAIN - PHASE 5 : en attente du BC.", handled: true }));
  assert.deepEqual(await mod.handlePulseRoomBeforeDispatch(
    { messageId: "3EB0X", timestamp: 1792165616764, content: "état projet zain phase 5", body: "état projet zain phase 5", channel: "whatsapp", sessionKey: fourthKey, isGroup: false },
    { messageId: "3EB0X", channelId: "whatsapp", sessionKey: fourthKey }, r), { handled: true, text: "ZAIN BAHRAIN - PHASE 5 : en attente du BC." });
  assert.equal(r.calls[0].dialogue.event.eventRef, "3EB0X");
  assert.equal(r.calls[0].dialogue.event.admittedAt, 1792165616764);
  assert.equal(r.calls[0].message, "état projet zain phase 5");
  // The envelope in body (« [WhatsApp …] … : ») never replaces the sender's text.
  r = runner((m) => (assert.equal(m, "état projet zain"), { outcome: "COMPLETED", text: "ok", handled: true }));
  await mod.handlePulseRoomBeforeDispatch({ content: "état projet zain", body: "[WhatsApp +21610000006 +2s Mon 2026-10-12 17:01:22 UTC] +21610000006: état projet zain", channel: "whatsapp", sessionKey: fourthKey }, { sessionKey: fourthKey }, r);
  r = runner(() => { throw new Error("must not run"); });
  for (const key of [`agent:main:whatsapp:direct:${fourth}`, `agent:contacts:whatsapp:direct:${fourth}`]) {
    assert.deepEqual(await mod.handlePulseRoomBeforeDispatch({ content: "état projet zain", channel: "whatsapp", sessionKey: key }, { channelId: "whatsapp", sessionKey: key }, r), { handled: false });
  }
  assert.deepEqual(await mod.handlePulseRoomBeforeDispatch({ content: "x", channel: "whatsapp", sessionKey: fourthKey, isGroup: true }, { sessionKey: fourthKey }, r), { handled: false });
  assert.equal(r.calls.length, 0);
  const index = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/index.ts"), "utf8");
  assert.match(index, /api\.on\("before_dispatch"[\s\S]{0,800}handlePulseRoomBeforeDispatch/);

  // Helper failure or coordinator unavailable: a clear message, never a model guess.
  for (const broken of [() => ({ status: "error", reason: "helper_failed" }), () => ({ outcome: "TECHNICAL_FAILURE", reasonCode: "coordinator_unavailable", handled: true })]) {
    r = runner(broken);
    assert.match((await mod.handlePulseRoomFastPath(ev("état de l'offre 20447"), ctx(), r)).reply.text, /indisponible/);
  }
  // Maintenance: the deterministic reply of the coordinator is passed through.
  r = runner(() => ({ outcome: "MAINTENANCE", text: "Samantha est en maintenance pour quelques minutes.", handled: true }));
  assert.match((await mod.handlePulseRoomFastPath(ev("état de l'offre 20447"), ctx(), r)).reply.text, /maintenance/);

  // Amine 26/10 « il faut gérer ce genre de demande automatiquement »: Sadok's real message (S24 15:37:50Z) is two
  // requests, run one after the other as two admitted events of the same conversation.
  const sadok = "1. État su projet zain phase 5\n2. Passe la phase réalisation du projet 20495 a non débuté";
  const split = require("../dist/dialogueSurface.js").splitRequests;
  assert.deepEqual(split(sadok), ["État su projet zain phase 5", "Passe la phase réalisation du projet 20495 a non débuté"]);
  assert.deepEqual(split("- offre 20447\n  et son forecast\n- congés de l'équipe"), ["offre 20447\net son forecast", "congés de l'équipe"]);
  for (const one of ["nom projet zain_phase_5.1\nclient zain bahrain", "Voici :\n1. a\n2. b", "1. une seule demande",
    "état du projet 20495", "réunion à\n10:30 demain", Array.from({ length: 11 }, (_, n) => `${n + 1}. x`).join("\n")])
    assert.equal(split(one).length, 1, one);
  r = runner((m) => m.startsWith("État") ? { outcome: "COMPLETED", text: "ZAIN BAHRAIN - PHASE 5 : Réalisation débutée.", handled: true }
    : { outcome: "COMPLETED", text: "Phase Réalisation du projet 20495 : Non débuté.", handled: true });
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev(sadok), ctx({ runId: "AC0815" }), r), { handled: true, reply: { text:
    "1) ZAIN BAHRAIN - PHASE 5 : Réalisation débutée.\n\n2) Phase Réalisation du projet 20495 : Non débuté." } });
  assert.deepEqual(r.calls.map((c) => [c.message, c.dialogue.event.eventRef, c.dialogue.event.queuedRequests]), [
    ["État su projet zain phase 5", "AC0815#1", ["Passe la phase réalisation du projet 20495 a non débuté"]],
    ["Passe la phase réalisation du projet 20495 a non débuté", "AC0815#2", undefined]]);
  assert.equal(r.calls[0].dialogue.event.conversationKey, r.calls[1].dialogue.event.conversationKey);
  // A question stops the run; the coordinator keeps the next request and hands it back with the answer turn.
  r = runner((m, o, n) => n === 1 ? { outcome: "NEEDS_CHOICE", text: "Quel projet Zain ?", handled: true, queuedCount: 1, question: { version: 1, kind: "choice" } }
    : n === 2 ? { outcome: "COMPLETED", text: "ZAIN BAHRAIN - PHASE 5 : en cours.", handled: true, resumeRequests: ["Passe la phase réalisation du projet 20495 a non débuté"] }
    : { outcome: "COMPLETED", text: "Phase Réalisation du projet 20495 : Non débuté.", handled: true });
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev(sadok), ctx({ runId: "AC0816" }), r), { handled: true, reply: { text:
    "Quel projet Zain ?\n\nJ’ai gardé l’autre demande de ton message : je la traite dès ta réponse." } });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("Zain Bahrain"), ctx({ runId: "AC0817" }), r), { handled: true, reply: { text:
    "1) ZAIN BAHRAIN - PHASE 5 : en cours.\n\n2) Phase Réalisation du projet 20495 : Non débuté." } });
  assert.deepEqual(r.calls.slice(1).map((c) => [c.message, c.dialogue.event.eventRef]), [
    ["Zain Bahrain", "AC0817"], ["Passe la phase réalisation du projet 20495 a non débuté", "AC0817#r1"]]);
  // An older coordinator that keeps nothing: the contact is told the rest was not run.
  r = runner(() => ({ outcome: "NEEDS_INPUT", text: "Quel projet ?", handled: true, question: { version: 1, kind: "input" } }));
  assert.match((await mod.handlePulseRoomFastPath(ev(sadok), ctx({ runId: "AC0818" }), r)).reply.text, /n’ont pas été traitées/);
  assert.equal(r.calls.length, 1);

  // C16 native codes retain their owner cause in the actual room renderer.
  // The authority port is MOCK_ONLY; no provider or business call is made.
  const allowlist=require('../dist/companion/whatsappAllowlist');
  allowlist.allowlistRead=async()=>({success:true,contactId:CONTACT,e164:NUMBER,owner:false,state:'active',rooms:['pulse'],expiresAt:null});
  process.env.SAMANTHA_NATIVE_PULSE_HANDOFF='1';
  const render=require('../dist/companion/receiptPresentation');
  for(const [outcome,code] of [['TECHNICAL_FAILURE','native_pulse_protocol_required'],
      ['FAILED','native_pulse_execution_unknown'],['FAILED','pulse_native_contract_changed'],
      ['DENIED','native_pulse_admission_required']]){
    r=runner(()=>({outcome,reasonCode:code,text:'UNTRUSTED_CANARY',handled:true}));
    const out=await mod.handlePulseRoomFastPath(ev('phase du projet 20495'),ctx(),r);
    assert.equal(out.reply.text,render.FAILURE_PHRASES.fr[code]);
    assert(!out.reply.text.includes('UNTRUSTED_CANARY'));assert.equal(r.calls.length,1);
  }
  // Native room: every request of the message gets its own admission (eventRef and text bound), turn and hand-off.
  r=runner((m,o)=>o.dialogue.mode==='turn'?{outcome:'READY',handled:true,pendingHandoff:{goalRef:'g-'+o.dialogue.event.eventRef,klass:'FAST'}}
    :{outcome:'COMPLETED',text:'fait : '+m,handled:true});
  const native=await mod.handlePulseRoomFastPath(ev(sadok),ctx({runId:'AC0819'}),r);
  assert.equal(native.reply.text,'1) fait : État su projet zain phase 5\n\n2) fait : Passe la phase réalisation du projet 20495 a non débuté');
  for(const c of r.calls){assert.equal(c.nativePulse.eventRef,c.dialogue.event.eventRef);assert.equal(c.nativePulse.originalText,c.message);}
  assert.deepEqual(r.calls.map(c=>[c.dialogue.mode,c.dialogue.event.eventRef]),[['turn','AC0819#1'],['handoff','AC0819#1'],['turn','AC0819#2'],['handoff','AC0819#2']]);
  assert.notEqual(r.calls[0].nativePulse,r.calls[2].nativePulse);
  delete process.env.SAMANTHA_NATIVE_PULSE_HANDOFF;

  console.log("pulse room fast path OK");
}

main().catch((error) => { console.error(error); process.exit(1); });
