const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.CLAW_VOICE_RELAY_CONFIG =
  path.join(os.homedir(), ".openclaw", "tmp", "voice-relay-test-missing.json");

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

const clarification = mod.renderFastVoiceResult({
  execution: {
    state: "completed",
    result: {
      state: "needs_counter",
      sent: false,
      choices: ["recharge", "balances"],
    },
  },
});
assert.match(clarification, /Précise/);

const health = mod.startVoiceRelay();
assert.equal(health.state, "disabled");
assert.equal(health.configured, false);
assert.equal(health.connected, false);
mod.stopVoiceRelay();

console.log("voice-relay tests: PASS");
