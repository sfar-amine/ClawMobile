// O10 (fichier 37) : la voix exécute directement une capability déterministe sans confirmation de risque
// "read" ou "low" (samantha.voice.decision.record), jamais un paiement ni un chemin confirmé.
// Formes : sortie réelle du Capability Graph pour « note que je préfère les réponses courtes » (playbooks O10) et
// résolution capturée sur le S24 pour « Mon solde Orange » (fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {deterministicVoiceAdmission, extractFastClarification, renderFastVoiceResult} = require("../dist/companion/voiceRelay.js");

const capture = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json"), "utf8"));
const orange = {selected: capture.resolution_now.claw_live.selected, confirmation_required: false};
assert.equal(deterministicVoiceAdmission(orange), true, "read stays admitted");

const decision = {
  capability: "samantha.voice.decision.record", confirmation_required: false,
  selected: {executor: "claw.capability_runtime", capability: "samantha.voice.decision.record", entrypoint: "python3 -B tools/voice_decision.py",
    deterministic: true, risk: "low", confirmation_required: false, owner_only: true, state: "ready", authorized: true},
};
assert.equal(deterministicVoiceAdmission(decision), true, "low risk voice decision admitted");
for (const risk of ["write", "transaction", "external_send", "sensitive", "destructive", ""]) {
  assert.equal(deterministicVoiceAdmission({...decision, selected: {...decision.selected, risk}}), false, risk);
}
assert.equal(deterministicVoiceAdmission({...decision, confirmation_required: true}), false);
assert.equal(deterministicVoiceAdmission({...decision, selected: {...decision.selected, confirmation_required: true}}), false);
assert.equal(deterministicVoiceAdmission({...decision, selected: {...decision.selected, deterministic: false}}), false);
assert.equal(deterministicVoiceAdmission({...decision, success: false}), false);
assert.equal(deterministicVoiceAdmission({selected: null}), false);

// Executed result: recorded decision is spoken, a missing parameter becomes the question, a refusal is not spoken.
const recorded = {execution: {state: "completed", result: {ok: true, action: "recorded", surface: "voice",
  event_id: "a".repeat(64), supersedes: null, message: "C'est noté : « je préfère les réponses courtes »."}}};
assert.equal(renderFastVoiceResult(recorded), "C'est noté : « je préfère les réponses courtes ».");
const missing = {execution: {state: "completed", result: {ok: false, state: "needs_parameter", question: "Quelle décision veux-tu que je note ?"}}};
assert.deepEqual(extractFastClarification(missing), {question: "Quelle décision veux-tu que je note ?", choices: []});
assert.equal(renderFastVoiceResult(missing), null);
const refused = {execution: {state: "failed", result: {ok: false, reason: "payment_or_secret_refused", message: "Je ne note ni paiement ni code ni secret comme décision."}}};
assert.equal(renderFastVoiceResult(refused), null);
assert.equal(extractFastClarification(refused), null);
console.log("O10 voice low-risk admission: PASS");
