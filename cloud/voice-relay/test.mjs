import assert from "node:assert/strict";
import {
  normalizeVoiceRequest,
  parseBearer,
  voiceTurnKey,
} from "./src/index.mjs";

const request = new Request("https://relay.example/voice", {
  headers: { authorization: "Bearer owner-test-token-1234567890" },
});
assert.equal(parseBearer(request), "owner-test-token-1234567890");

assert.deepEqual(
  normalizeVoiceRequest({
    requestId: "bixby-123",
    request: "mon solde Orange",
  }),
  { requestId: "bixby-123", request: "mon solde Orange" },
);

assert.deepEqual(
  normalizeVoiceRequest({
    requestId: "bixby-124",
    conversationId: "conv-abc",
    answer: "tous les soldes",
  }),
  {
    requestId: "bixby-124",
    conversationId: "conv-abc",
    answer: "tous les soldes",
  },
);

assert.notEqual(
  voiceTurnKey({ request: "mon solde Orange" }),
  voiceTurnKey({ conversationId: "conv-abc", answer: "tous les soldes" }),
);

assert.throws(
  () => normalizeVoiceRequest({ requestId: "", request: "x" }),
  /invalid_request_id/,
);
assert.throws(
  () => normalizeVoiceRequest({ requestId: "ok", request: "" }),
  /invalid_request/,
);
assert.throws(
  () =>
    normalizeVoiceRequest({
      requestId: "ok",
      conversationId: "conv-abc",
      answer: "",
    }),
  /invalid_answer/,
);
assert.throws(
  () =>
    normalizeVoiceRequest({
      requestId: "ok",
      request: "x",
      conversationId: "conv-abc",
      answer: "y",
    }),
  /ambiguous_voice_turn/,
);

console.log("voice-relay worker tests: PASS");
