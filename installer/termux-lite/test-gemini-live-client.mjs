import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const secret = await resolveGeminiApiKey({ GEMINI_API_KEY: "test-google-key-for-host-ci" });
assert.equal(secret, "test-google-key-for-host-ci");

// OpenClaw 2026.10.9 layout (S24, 04/11): the facade exports readSecretStoreValue by
// name, the implementation chunk exports writeSecretStoreEntries as minified `c`.
// Before the fix the helper called `c` (a write) and the voice token mint died with exit 1.
const S24_FACADE_EXPORTS = "assertSecretStoreValue, deleteSecretStoreEntry, listSecretStoreEntries, normalizeSecretAllowedHosts, purgeExpiredSecretStoreEntries, readSecretStoreExecEnvironment, readSecretStoreValue, updateSecretStoreAllowedHosts, writeSecretStoreEntries, writeSecretStoreEntry, writeSecretStoreEntryForConfigRef, writeSecretStoreEntryWithRollback";
function fakeDist(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-dist-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
const writeTrap = "async function w(){ globalThis.__secretWrites = (globalThis.__secretWrites || 0) + 1; return []; }\n";
const facade = writeTrap + S24_FACADE_EXPORTS.split(", ").filter((n) => n !== "readSecretStoreValue")
  .map((n) => `const ${n} = w;`).join("\n")
  + "\nasync function readSecretStoreValue(q){ return q && q.name === 'GEMINI_API_KEY' && !q.scope ? { ok: true, value: 'fixture-gemini-key' } : { ok: false }; }\n"
  + `export { ${S24_FACADE_EXPORTS} };\n`;
const chunk = writeTrap + "async function r(){ return { ok: true, value: 'wrong-chunk' }; }\nexport { r as readSecretStoreValue_, w as c, r as readSecretStoreValue };\n";
const dist109 = fakeDist({
  "secret-store-Bm1MKYpk.mjs": facade,
  "secret-store-CnrQoIoy.mjs": chunk,
  "secret-store-validation-DiqaFVNK.mjs": writeTrap + "export { w as c };\n"
});
assert.equal(await resolveGeminiApiKey({}, { distDir: dist109 }), "fixture-gemini-key");
assert.equal(globalThis.__secretWrites || 0, 0, "no secret-store write may run while resolving the key");
const distLegacyOnly = fakeDist({ "secret-store-CnrQoIoy.mjs": writeTrap + "export { w as c };\n" });
await assert.rejects(resolveGeminiApiKey({}, { distDir: distLegacyOnly }), /gemini_api_key_unavailable/);
assert.equal(globalThis.__secretWrites || 0, 0, "a minified export is never called");
await assert.rejects(resolveGeminiApiKey({}, { distDir: path.join(dist109, "missing") }), /gemini_api_key_unavailable/);

console.log(JSON.stringify({
  ok: true,
  model: MODEL,
  tool: declaration.name,
  secretResolved: true
}));
