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

const recharge = mod.renderFastVoiceResult({
  execution: {
    state: "completed",
    result: {
      ok: true,
      data: { recharge: { value: "1.234", unit: "TND" } },
    },
  },
});
assert.match(recharge, /solde de recharge/);
assert.match(recharge, /1\.234 TND/);

const orangeSummary = mod.renderFastVoiceResult({
  execution: {
    state: "completed",
    result: {
      ok: true,
      data: {
        balances: {
          recharge: { value: "26.540", unit: "TND" },
          forfait: { value: "11", unit: "TND" },
          forfait_bonus: { value: "74.900", unit: "TND" },
        },
        cards: [
          { title: "Compte de recharge", value: "26.540", unit: "TND" },
          { title: "Bonus internet mobile", value: "22.82", unit: "GO" },
        ],
      },
    },
  },
});
assert.match(orangeSummary, /solde de recharge : 26\.540 TND/);
assert.match(orangeSummary, /forfait : 11 TND/);
assert.match(orangeSummary, /bonus sur recharge : 74\.900 TND/);
assert.match(orangeSummary, /Bonus internet mobile : 22\.82 GO/);
assert.equal((orangeSummary.match(/26\.540 TND/g) || []).length, 1);

const clarificationValue = {
  execution: {
    state: "completed",
    result: {
      state: "needs_counter",
      sent: false,
      choices: ["recharge", "balances"],
    },
  },
};
const clarification = mod.extractFastClarification(clarificationValue);
assert.equal(
  clarification.question,
  "Précise : solde de recharge ou tous les soldes.",
);
assert.deepEqual(clarification.choices, ["recharge", "balances"]);
assert.equal(mod.renderFastVoiceResult(clarificationValue), null);

assert.equal(
  mod.composeContinuationRequest("mon solde Orange", "tous les soldes"),
  "mon solde Orange\nPrécision utilisateur : tous les soldes",
);

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
