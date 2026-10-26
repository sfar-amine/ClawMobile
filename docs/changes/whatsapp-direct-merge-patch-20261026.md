# Lowering a WhatsApp scope really removes the prompt — 26 October 2026

On 26/10 at 14:25 UTC, Amine asked to remove Sadok's custom scope (« Zain Bahrain »). The owner sent the whole `channels.whatsapp.direct` map, marked in `replacePaths`. The S24 Gateway (OpenClaw 2026.9.6, `applyMergePatch`) merges objects, and `replacePaths` only replaces arrays. So the Gateway logged « config.patch noop (no changed paths) ». The verification then failed and the receipt was `indeterminate`. The contact kept its prompt and its custom scope (we checked: no effect). Every scope lowering, suspension or removal that drops a rule had the same defect. The test Gateway replaced the map in one go, which hid it.

- `people-trusted.py`: the change to the `direct` map is now sent as an RFC 7396 merge patch (`merge_diff`). A removed rule or field is an explicit `null`, under the same CAS `baseHash`, with the same single verification. `allowFrom` and `bindings` (arrays) are still replaced through `replacePaths`.
- `test-whatsapp-allowlist.py`: the fake Gateway applies the real semantics. A new test covers Sadok's exact case.

Tests: 48/48. Without the fix, 4 tests fail, as on the S24. The owner suites pass. Rollback: revert this commit.
