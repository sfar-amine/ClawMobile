import assert from "node:assert/strict";
import {
  MODEL,
  buildSetupMessage,
  buildToolResponse,
  compactCapabilityResult,
  createEphemeralToken,
  executeCapability,
  resolveGeminiApiKey
} from "./gemini-live-client.mjs";

const setup = buildSetupMessage("claw_live");
assert.equal(setup.setup.model, `models/${MODEL}`);
assert.deepEqual(setup.setup.generationConfig.responseModalities, ["AUDIO"]);
assert.equal(setup.setup.tools.length, 1);
const declaration = setup.setup.tools[0].functionDeclarations[0];
assert.equal(declaration.name, "clawmobile_capability");
assert.equal(declaration.behavior, "BLOCKING");
assert.deepEqual(declaration.parameters.required, ["request"]);
const compact = compactCapabilityResult({
  capability_revision: "rev1",
  capability: "telecom.orange.consultation",
  confirmation_required: false,
  matches: new Array(100).fill({ noisy: true }),
  selected: { executor: "claw.skill_route", route: "orange.balance", risk: "read", state: "ready" },
  execution: { state: "completed", executor: "claw.skill_route", route: "orange.balance", result: { ok: true } }
});
assert.equal(compact.capability, "telecom.orange.consultation");
assert.equal("matches" in compact, false);
assert.equal(compact.execution.result.ok, true);

const clarification = compactCapabilityResult({
  capability: "telecom.orange.consultation",
  confirmation_required: false,
  selected: { executor: "claw.skill_route", route: "orange.balance", risk: "read", state: "ready" },
  execution: {
    state: "completed",
    executor: "claw.skill_route",
    route: "orange.balance",
    result: { ok: false, state: "needs_counter", sent: false, choices: ["recharge", "balances"] }
  }
});
assert.equal(clarification.execution.state, "needs_clarification");
assert.deepEqual(clarification.execution.choices, ["recharge", "balances"]);
assert.equal("result" in clarification.execution, false);

const toolResponse = buildToolResponse({
  functionCalls: [{ name: "clawmobile_capability", id: "call1" }]
}, [{ capability: "telecom.orange.consultation" }]);
assert.equal(toolResponse.toolResponse.functionResponses[0].id, "call1");
let captured;
const fakeFetch = async (_url, init) => {
  captured = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        success: true,
        capability_revision: "rev2",
        capability: "telecom.orange.consultation",
        selected: { executor: "claw.skill_route", route: "orange.balance", risk: "read", state: "ready" },
        execution: { state: "completed", result: { ok: true } }
      };
    }
  };
};
const bridged = await executeCapability("mon solde orange", { fetchImpl: fakeFetch });
assert.equal(captured.surface, "claw_live");
assert.equal(captured.caller, "owner");
assert.equal(bridged.capability, "telecom.orange.consultation");

let tokenHeaders;
const token = await createEphemeralToken({
  apiKey: "test-google-key",
  now: 1_000,
  fetchImpl: async (_url, init) => {
    tokenHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      async json() {
        return { name: "ephemeral-test-token" };
      }
    };
  }
});
assert.equal(token.token, "ephemeral-test-token");
assert.equal(token.model, MODEL);
assert.equal(tokenHeaders["x-goog-api-key"], "test-google-key");

const secret = await resolveGeminiApiKey({});
assert.equal(typeof secret, "string");
assert.ok(secret.length >= 20);

console.log(JSON.stringify({
  ok: true,
  model: MODEL,
  tool: declaration.name,
  secretResolved: true
}));
