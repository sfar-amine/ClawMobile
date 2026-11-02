const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.CLAW_VOICE_RELAY_CONFIG = path.join(
  os.homedir(),
  ".openclaw",
  "tmp",
  "voice-relay-test-missing.json",
);

const mod = require("../dist/companion/voiceRelay.js");

assert.equal(mod.reconnectDelay(0), 0);
assert.equal(mod.reconnectDelay(1), 750);
assert.equal(mod.reconnectDelay(2), 2000);
assert.ok(mod.reconnectDelay(8) <= 60000);

// ADR 02/11 « le cerveau partout », step 3: the relay no longer renders a deterministic result nor composes
// « Précision utilisateur »; the brain answers and its question is projected as is.
for (const legacy of ["renderFastVoiceResult", "extractFastClarification", "composeContinuationRequest", "deterministicVoiceAdmission"])
  assert.equal(mod[legacy], undefined, legacy);

assert.equal(
  mod.looksLikeClarificationQuestion("Quelle facture veux-tu payer ?"),
  true,
);
assert.equal(
  mod.looksLikeClarificationQuestion("La facture a été payée."),
  false,
);

assert.deepEqual(
  mod.classifyAgentTurn({
    state: "needs_clarification",
    question: "Quel compte veux-tu utiliser ?",
  }),
  {
    state: "needs_clarification",
    question: "Quel compte veux-tu utiliser ?",
  },
);

assert.deepEqual(
  mod.classifyAgentTurn({ final: { text: "C'est fait." } }),
  { state: "done", text: "C'est fait." },
);

const health = mod.startVoiceRelay();
assert.equal(health.state, "disabled");
assert.equal(health.configured, false);
assert.equal(health.pendingConversations, 0);
mod.stopVoiceRelay();

console.log("voice-relay tests: PASS");
