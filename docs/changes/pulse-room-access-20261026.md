# Pulse room access and WhatsApp scope lowering — 26 October 2026

On 26/10 at 14:25 UTC, Amine asked to remove Sadok's custom scope (« Zain Bahrain »). The owner sent the whole `channels.whatsapp.direct` map, marked in `replacePaths`. The S24 Gateway (OpenClaw 2026.9.6, `applyMergePatch`) merges objects, and `replacePaths` only replaces arrays. So the Gateway logged « config.patch noop (no changed paths) ». The verification then failed and the receipt was `indeterminate`. The contact kept its prompt and its custom scope (we checked: no effect). Every scope lowering, suspension or removal that drops a rule had the same defect. The test Gateway replaced the map in one go, which hid it.

- `people-trusted.py`: the change to the `direct` map is now sent as an RFC 7396 merge patch (`merge_diff`). A removed rule or field is an explicit `null`, under the same CAS `baseHash`, with the same single verification. `allowFrom` and `bindings` (arrays) are still replaced through `replacePaths`.
- `test-whatsapp-allowlist.py`: the fake Gateway applies the real semantics. A new test covers Sadok's exact case.

Tests: 48/48. Without the fix, 4 tests fail, as on the S24. The owner suites pass. Rollback: revert this commit.

## Pulse room access (Amine, 26/10, S24 3289)

At 14:16 UTC, Sadok received « L’accès actuel à la pièce Pulse n’est pas établi ». `_native_pulse_context_read` refused him (`NATIVE_ROOM_ACCESS_UNVERIFIED`) because his conversation scope was custom and his memory had been compacted on 17/10. Amine's decision: whoever has the Pulse room can do everything in Pulse through it, without global owner privileges.

- The room's checks remain: contact active and not expired, exact rooms, exact binding, closed agent profile, tools and workspace.
- Scope, scope prompt and compacted memory no longer block access: they only shape the model agent, which the native path never runs.
- The Gateway prompt must still match the stored scope, and an unknown prompt is still refused.
- Paired test (playbooks `tests/test_native_room_context.py`, run against this head): Sadok's real shape is admitted, and the old core refuses it.
- The other test fakes (`test-whatsapp-allowlist-paired`, `test-whatsapp-rooms-paired`, `test-ui-recette-server`) apply the same merge semantics.
