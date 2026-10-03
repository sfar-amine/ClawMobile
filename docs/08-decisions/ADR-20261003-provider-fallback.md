# ADR — Bounded inter-provider fallback

Date: 2026-10-03

## Decision

Keep the existing OpenAI `main` model chain (`GPT-5.6 Sol` then `GPT-5.6 Luna`) and add one bounded inter-provider fallback to the existing Google Gemini Free Tier agent only after a terminal OpenAI provider failure.

Implement the coordination inside the existing mobile plugin and reuse `gemini-request.py`. Do not add a router service, daemon, scheduler, database or provider-specific memory store.

## Constraints

- Google must remain Free Tier only with no paid reroute or automatic billing upgrade.
- The fallback is answer-only and must never duplicate an already-started action.
- A turn that called any tool is therefore ineligible.
- Attachments are ineligible until their semantics can be preserved safely.
- Trusted WhatsApp identity comes from the existing allowlist; no new identity source is introduced.
- Provider fallback sends no private Claw memory payload to the trusted-contact Google turn.
- Existing deterministic fast paths and the OpenAI primary route remain preferred.

## Consequences

OpenAI provider cooldown can still yield a conversational answer when Google Free Tier is healthy. Google quota exhaustion degrades cleanly without paid fallback. Action turns remain fail-closed instead of risking double execution.

The fallback is deliberately narrower than a general multi-provider router. This keeps the runtime simple and preserves the existing canonical capability/memory architecture.

## Alternatives rejected

- Adding another OpenAI model only: does not protect against provider-wide OpenAI cooldown.
- General automatic provider router: unnecessary complexity and higher risk of action replay or cost-policy drift.
- Parallel OpenAI + Gemini execution: duplicates model cost/work and conflicts with the agreed non-parallel tandem model.

## Rollback

Revert this ADR's implementation commit, rebuild the plugin and restore the prior `gemini-request.py`. No data migration is required.
