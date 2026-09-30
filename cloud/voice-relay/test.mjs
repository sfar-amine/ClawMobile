import assert from "node:assert/strict";
import { normalizeVoiceRequest, parseBearer } from "./src/index.mjs";

const request = new Request("https://relay.example/voice", {
  headers: { authorization: "Bearer owner-test-token-1234567890" },
});
assert.equal(parseBearer(request), "owner-test-token-1234567890");
assert.deepEqual(
  normalizeVoiceRequest({ requestId: "bixby-123", request: "mon solde Orange" }),
  { requestId: "bixby-123", request: "mon solde Orange" },
);
assert.throws(
  () => normalizeVoiceRequest({ requestId: "", request: "x" }),
  /invalid_request_id/,
);
assert.throws(
  () => normalizeVoiceRequest({ requestId: "ok", request: "" }),
  /invalid_request/,
);
console.log("voice-relay worker tests: PASS");
