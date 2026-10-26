# Provider failure is not an invalid decision — 25 October 2026

Since 16:32 UTC on 25 October, the OpenAI subscription has answered `gpt-5.6-sol` with `429 usage_limit_reached`; the Codex quota is exhausted on the same account. The OpenClaw Gateway log shows the 429 and a "plugin llm completion" with zero usage for purpose `samantha.engineering.immune`. OpenClaw's `llm.complete` resolves such a provider error with empty text and a non-completed stop reason. The Companion interpreter port then reported `INVALID_DECISION_OUTPUT`, which the playbooks owner maps to `invalid_output`.

Two consequences followed:
- Sol received no cooldown, because `invalid_output` is not a transient status.
- The immune profile, which falls back to Luna only after a technical Sol failure, stayed blocked. Every supervisor restore was refused, the post-deploy Tier0 SOAK rolled back on `immune.health_manager` and `immune.incident_orchestrator`, and the 15-minute engineering audit failed on every pass.

The port now classifies an empty completion whose stop reason is outside OpenClaw's own completed set (`stop`, `length`, `toolUse`) as `LLM_COMPLETION_FAILED`, a technical failure. Through the existing mapping this becomes `unavailable`: Sol gets its normal cooldown, and the existing immune fallback to Luna applies.

Unchanged:
- An empty text with a completed stop, and any unparsable text, remain `INVALID_DECISION_OUTPUT`.
- The model sets, admission rules, budgets and deadlines.
- Gemini stays excluded from the immune purpose.

Evidence: `scripts/test-intent-interpreter-port.cjs` gains:
- the observed provider-error shape for the interpretation fallback;
- the same shape for both immune models;
- the completed-but-empty control case.

The new assertion fails without the fix; the whole file passes with it. Rollback: revert this commit.
