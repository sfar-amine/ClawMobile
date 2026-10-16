const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const patch = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../docs/runtime/config/samantha-provider-fallback.json"),
    "utf8",
  ),
);
const expected = "google/gemini-3.5-flash-lite@google:claw-gemini-free";

assert.deepEqual(Object.keys(patch), ["agents"]);
assert.deepEqual(Object.keys(patch.agents.entries), ["main"]);
assert.equal(
  patch.agents.entries.main.model.primary,
  undefined,
  "Do not replace the owner-selected primary",
);
assert.deepEqual(patch.agents.entries.main.model.fallbacks, [
  "openai/gpt-5.6-luna",
  expected,
]);
assert.deepEqual(patch.agents.entries.main.modelPolicy.allow, [
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-luna",
  "google/gemini-3.5-flash-lite",
]);

console.log(
  JSON.stringify({
    ok: true,
    mainOnly: true,
    primaryPreserved: true,
    freeProfilePinned: true,
    nativeOpenClawFallback: true,
  }),
);
