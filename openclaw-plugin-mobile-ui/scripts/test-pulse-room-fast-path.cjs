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
const decision = (route, intent, extra = {}) => ({ type: "EXECUTE", target: route.startsWith("pulse.") ? "pulse" : "maxit-tunisie", route, intent, risk: "read", confirmationRequired: false,
  selected: { target: route.startsWith("pulse.") ? "pulse" : "maxit-tunisie", route, intent }, ...extra });

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
  for (const [e, c] of [
    [ev("x", { isGroup: true }), ctx()],
    [ev("x", { senderIsOwner: true }), ctx()],
    [ev("x"), ctx({ agentId: "contacts", sessionKey: `agent:contacts:whatsapp:direct:${NUMBER}` })],
    [ev("x"), ctx({ agentId: "contacts-projet", sessionKey: `agent:contacts-projet:whatsapp:direct:${NUMBER}` })],
    [ev("x"), ctx({ agentId: "main", sessionKey: `agent:main:whatsapp:direct:${NUMBER}` })],
    [ev("x"), ctx({ agentId: "contacts" })],
    [ev("x"), ctx({ channel: "slack" })],
  ]) assert.equal(mod.pulseRoomContact(e, c), null);

  assert.equal(mod.pulseRoomVerdict(decision("pulse.offer.forecast.set", "offer.forecast.set", { risk: "write" })), "allowed");
  assert.equal(mod.pulseRoomVerdict(decision("pulse.leave.balance", "leave.balance")), "allowed");
  assert.equal(mod.pulseRoomVerdict(decision("pulse.leave.request", "leave.request", { risk: "write" })), "leave_request");
  assert.equal(mod.pulseRoomVerdict(decision("orange.summary.maxit.v1", "telecom.balance")), "outside");
  assert.equal(mod.pulseRoomVerdict({ ...decision("pulse.project.search", "project.snapshot"), selected: { target: "maxit-tunisie", route: "orange.x" } }), "outside");
  assert.equal(mod.pulseRoomVerdict(decision("pulse.project.search", "project.snapshot", { confirmationRequired: true })), "outside");
  assert.equal(mod.pulseRoomVerdict(null), "outside");

  // A Pulse write: check once, then execute that prepared decision as Amine, the contact named in the origin.
  const write = decision("pulse.offer.forecast.set", "offer.forecast.set", { risk: "write" });
  let r = runner((m, o) => o.checkOnly ? { status: "eligible", decision: write } : { status: "hit", text: "Forecast de l'offre 20447 : mai 2027 passé à 55 JH." });
  let out = await mod.handlePulseRoomFastPath(ev("mets le forecast de l'offre 20447 en mai 2027 à 55 JH"), ctx(), r);
  assert.deepEqual(out, { handled: true, reply: { text: "Forecast de l'offre 20447 : mai 2027 passé à 55 JH." } });
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].checkOnly, true); assert.equal(r.calls[0].caller, "owner"); assert.equal(r.calls[0].surface, "whatsapp");
  assert.equal(r.calls[1].preparedDecision, write); assert.equal(r.calls[1].checkOnly, false);
  assert.equal(r.calls[1].originId, `pulse-room:${CONTACT}:run-1`);

  // Outside the room, and the leave request: refused, nothing executed.
  for (const [text, dec, expected] of [
    ["mon solde orange", decision("orange.summary.maxit.v1", "telecom.balance"), mod.PULSE_ROOM_REFUSAL],
    ["pose un congé jeudi", decision("pulse.leave.request", "leave.request", { risk: "write" }), "Une demande de congé se fait uniquement par Amine."],
  ]) {
    r = runner(() => ({ status: "eligible", decision: dec }));
    out = await mod.handlePulseRoomFastPath(ev(text), ctx(), r);
    assert.deepEqual(out, { handled: true, reply: { text: expected } });
    assert.equal(r.calls.length, 1); assert.equal(r.calls[0].checkOnly, true);
  }

  // A transaction whose route is unknown to Pulse (known_error from another family) is refused too.
  r = runner(() => ({ status: "known_error", text: "Paiement refusé", decision: decision("orange.recharge", "telecom.recharge") }));
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("recharge 5 dt"), ctx(), r), { handled: true, reply: { text: mod.PULSE_ROOM_REFUSAL } });

  // Plain conversation stays with the room agent (no tools): not handled here.
  r = runner(() => ({ status: "miss", reason: "model_allowed" }));
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("bonjour"), ctx(), r), { handled: false });
  // Not a room session: the runner is never called.
  r = runner(() => { throw new Error("must not run"); });
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("état du projet 20495"), ctx({ agentId: "contacts", sessionKey: `agent:contacts:whatsapp:direct:${NUMBER}` }), r), { handled: false });
  assert.equal(r.calls.length, 0);

  // Missing information: Samantha asks, then the answer resolves the held decision and is checked again.
  const clarify = { ...decision("pulse.project.search", "project.snapshot"), type: "CLARIFY" };
  const read = decision("pulse.project.search", "project.snapshot");
  r = runner((m, o, n) => n === 1 ? { status: "clarification", text: "Quel projet ?", decision: clarify }
    : n === 2 ? (assert.equal(o.clarificationDecision, clarify), assert.equal(o.clarificationOriginalText, "état du projet"), { status: "eligible", decision: read, resolution: { text: "état du projet Omniflow" } })
    : (assert.equal(o.preparedDecision, read), assert.equal(m, "état du projet Omniflow"), { status: "hit", text: "Omniflow : en cours." }));
  const conversation = ctx({ sessionKey: KEY + "" });
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("état du projet"), conversation, r), { handled: true, reply: { text: "Quel projet ?" } });
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("Omniflow"), conversation, r), { handled: true, reply: { text: "Omniflow : en cours." } });
  assert.equal(r.calls.length, 3);

  // A clarification answer that drifts outside Pulse is refused before execution.
  const other = "+21610000004"; const otherKey = `agent:contacts-pulse:whatsapp:direct:${other}`;
  r = runner((m, o, n) => n === 1 ? { status: "clarification", text: "Quel projet ?", decision: clarify } : { status: "eligible", decision: decision("orange.summary.maxit.v1", "telecom.balance") });
  await mod.handlePulseRoomFastPath(ev("état du projet", { sessionKey: otherKey }), ctx({ sessionKey: otherKey }), r);
  assert.deepEqual(await mod.handlePulseRoomFastPath(ev("mon solde orange", { sessionKey: otherKey }), ctx({ sessionKey: otherKey }), r), { handled: true, reply: { text: mod.PULSE_ROOM_REFUSAL } });
  assert.equal(r.calls.length, 2);

  // Helper failure: a clear message, never a model guess.
  r = runner(() => ({ status: "error", reason: "helper_failed" }));
  assert.match((await mod.handlePulseRoomFastPath(ev("état de l'offre 20447"), ctx(), r)).reply.text, /indisponible/);

  console.log("pulse room fast path OK");
}

main().catch((error) => { console.error(error); process.exit(1); });
