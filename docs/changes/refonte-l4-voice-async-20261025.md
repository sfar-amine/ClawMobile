# L4 — asynchronous voice receipt handoff (source preparation)

The existing voice protocol now uses Gemini's documented NON_BLOCKING generator for `ask_samantha`: SILENT running acknowledgement, bounded progress and final canonical receipt on the same call id, INTERRUPT delivery. It quarantines old generation tails until actual provider `turnComplete`, without treating an audio interruption as a business cancellation. The standard blocking clarification tool stays unchanged.

The real S24 metadata fixture retains the observed 22 second post-receipt gap and explicitly states that provider boundary events were not captured. Node tests exercise late PCM, `generationComplete` versus `interrupted`/`turnComplete`, one execution, same-call progress/final, owner interruption, absent boundary, forged client receipts, old-protocol fallback and duplicate delivery. A separate HTTP regression accepts the native closed `voice-readback-<uuid>` prefix and rejects arbitrary prefixes/identity conflicts. It is source/API proof, not an invented live deferred fixture.

No new route or capability: NO_CAPABILITY, existing voice surface lifecycle and transcript persistence. MCP primitives and transactional/human boundaries are unchanged. All new tests are registered in ci.yml. The existing 64-turn, 512-operation, six-progress-line and input/output limits remain.

Status: single-source transpile check passed12 new and37 existing protocol cases. This is not project typecheck or canonical CI. HTTP persistence/shared-budget tests, canonical CI and paired S24 recipe remain pending. No deployment or final acceptance claimed. Restore via existing Companion owner and paired standard APK for rollback.
