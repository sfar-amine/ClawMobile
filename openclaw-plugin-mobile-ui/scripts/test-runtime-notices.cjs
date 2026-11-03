const assert = require("node:assert/strict");
const { withoutRuntimeNotices, runtimeNoticeSendingHook } = require("../dist/runtimeNotices.js");

// S24 29/10 17:57: the exact notice Amine received after a WhatsApp reconnect.
const seen = "↪️ Model Fallback: openai/gpt-5.6-terra (selected openai/gpt-5.6-sol; unknown)";
assert.deepEqual(runtimeNoticeSendingHook({ content: seen }), { cancel: true });
assert.deepEqual(runtimeNoticeSendingHook({ content: "↪️ Model Fallback cleared: openai/gpt-5.6-sol" }), { cancel: true });
assert.deepEqual(runtimeNoticeSendingHook({ content: "↪️ Retried on Daybreak" }), { cancel: true });
// Same notice with or without the emoji variation selector.
assert.deepEqual(runtimeNoticeSendingHook({ content: "\u21AA Model Fallback: openai/gpt-5.6-terra (selected x; y)" }), { cancel: true });
// A notice prefixed to the real answer: only the answer is sent.
assert.deepEqual(runtimeNoticeSendingHook({ content: seen + "\nTu as 10 projets Pulse en cours :" }),
  { content: "Tu as 10 projets Pulse en cours :" });
// Everything else is untouched, including a user text that merely mentions a fallback.
for (const content of ["Tu as 10 projets Pulse en cours :", "Le Model Fallback est un réglage", "↪️ suite de la liste", "", undefined, 42]) {
  assert.equal(runtimeNoticeSendingHook({ content }), undefined, String(content));
}
assert.equal(withoutRuntimeNotices("Bonjour"), "Bonjour");
console.log("runtime notices: PASS (SDK model notices kept out of chats, answers untouched)");
