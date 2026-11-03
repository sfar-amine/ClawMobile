# Immune admission: Gemini free as third and last decider (Companion port) — 25 October 2026

**Decision.** Amine decided on 25/10 (S24 event `fcbe8c2a…`) that an exhausted OpenAI subscription quota is not a failure to fix. It will recur, and must be handled by a precise switch along the fallback chain Sol → Luna → Gemini free, with Gemini third and last.

**Change.** The Companion interpreter port, the credential owner, accepts `google/gemini-3.5-flash-lite@google:claw-gemini-free` as the third immune model. The order is now Sol, Luna, Gemini.
- OpenAI models keep the OAuth subscription requirement.
- Gemini stays pinned to its free profile, through the request and the existing allowlist (`docs/runtime/config/samantha-intent-interpreter.json` already lists it), so no API billing can occur.
- Any other Gemini model, or a profile-less Gemini reference, is still refused.

**Ownership.** Selection, order and the technical-failure-only fallback stay with the Python governor in samantha-ui-playbooks; its paired change ships separately.

**Size check.** The immune evidence observed on the S24 after 8 rounds stays under 6,400 characters, below Gemini's 12,000-character qualified input limit.

**Rollback.** Revert this commit; the immune purpose returns to Sol/Luna only.
