# Samantha native provider fallback and Warm cancellation — 6 October 2026

Task: `samantha-ux-ui-consolidation-20261005`. Owner requested correction and completion via RDC.

## Verified defects

The actual UX acceptance run `run_1791237011154_7b0ccd23` ended on 5 October at 21:50:31 UTC after Sol was in rate-limit cooldown and Luna returned a Codex usage-limit error. The native `main` model route contained only those two OpenAI models. The existing Model Governor already included Gemini, but does not own the Companion agent's native fallback list. The separate legacy provider hook covered trusted WhatsApp only. Neither statement established a Gemini attempt for Samantha.

Warm Core also failed a deterministic reproduction: reset during provider setup cleared the timeout and detached the socket without settling the waiter. Later prewarm calls inherited that unresolved promise. Cancellation during token creation and conversation changes require the same fencing.

## Correction

- Use OpenClaw's existing native per-agent fallback chain. The validated patch in `docs/runtime/config/samantha-provider-fallback.json` changes only `main.model.fallbacks` and `main.modelPolicy.allow`; the owner-selected primary is untouched. Order: Sol, Luna, then `google/gemini-3.5-flash-lite@google:claw-gemini-free`.
- The existing free-profile and efficiency guards passed, and the native auth inventory confirmed that exact Google profile is available to main. No credential, billing mode, other agent or provider slot was changed. No paid alternate is added.
- Native fallback preserves the same session and the native execution/refusal semantics; it is not an answer-only second conversation or a model invocation from a GET status handler.
- The legacy WhatsApp recovery hook does not call Google again after a native Google attempt and does not handle explicit terminal provider-policy refusals.
- Warm Core now settles cancelled token/setup waiters, fences stale completions by connection generation, and prevents an older completion from clearing a newer connection promise. Background prewarm preserves the bound conversation. Existing timeout, memory and reconnect budgets are unchanged.

## Validation

Before the fix, `test-claw-live-warm-cancellation.cjs` failed with `pending` instead of `rejected`. After the fix, setup/token cancellation, stale-token suppression, subsequent prewarm and conversation-switch cases pass. Existing Warm resumption/retry/history tests pass unchanged.

The plugin build and provider fallback, native fallback policy, Claw Live, Companion runs and MCP bridge regressions pass. The existing Gemini wrapper suite passes 19 tests. Native config dry-run passed schema and secret-reference resolvability checks without exposing credentials.

A new harmless request used the actual Companion `/v1/runs` route. Run `run_1791242547526_3605dba9` returned `SAMANTHA_FALLBACK_OK`; its Gateway receipt records `candidateProvider=google`, `candidateModel=gemini-3.5-flash-lite`, `attempt=3`, `candidateRouteOrigin=configured-fallback`, following Sol cooldown and Luna HTTP 429. Reported cost was zero. This is a real native fallback observation, not a forced provider override.

Evidence directory: private S24 `~/.openclaw/backups/samantha-ux-ui-20261005/fallback-warm-20261006/`. It contains before/after regressions, the scoped config rollback, canary result and correlated provider metadata. No original user request was replayed.

## Deployment gate

The native configuration is applied and its live fallback is verified. Warm source is tested but requires activation in the existing Companion owner, followed by the unchanged physical handshake and full text/voice/text acceptance. Source publication alone does not close the UX task. Test-owned sessions must be removed through the existing session API after final verification.

## Ownership and rollback

No new router, registry, scheduler, daemon, model worker or durable store is introduced. OpenClaw owns native inference fallback; the existing Companion Warm Core owns voice transport. Capability metadata remains in canonical ui-playbooks rather than being duplicated here.

Rollback restores only the two recorded main-agent arrays using a validated native config patch, or reverts this source commit after checking concurrent changes. Preserve the owner-selected primary, Google credential profile, independent MCP work and all business/payment state. Retain the pre-existing private APK and runtime rollback evidence.
