# OpenAI → Google Free provider fallback

## Runtime contract

The normal `main` agent remains unchanged:

1. `openai/gpt-5.6-sol`
2. `openai/gpt-5.6-luna`

Both are OpenAI models. The provider fallback activates only after the OpenAI turn reaches a terminal provider/rate-limit/cooldown reply.

For an eligible direct trusted WhatsApp text turn, the mobile plugin keeps the original prompt and observes the model lifecycle. If OpenAI exhausts its normal Sol/Luna path, the plugin calls the existing `gemini-request.py` wrapper in `--provider-fallback` mode.

The fallback is Google Free Tier only. The wrapper already enforces:

- provider = `google`;
- model = the configured free Gemini model;
- no provider/model reroute;
- no model fallback;
- reported provider cost must be zero.

If any invariant is not met, the fallback result is rejected.

## Safety boundaries

Provider fallback is answer-only.

It does not run when:

- the turn already called a tool;
- the input contains an attachment;
- the sender is not in the existing WhatsApp allowlist;
- the session is not the `main` direct WhatsApp path;
- the turn is not user-triggered.

The dedicated fallback Gemini session receives `toolsAllow: []`. The wrapper also omits Claw capability hints and private memory retrieval in provider-fallback mode. It receives only the current text message, generic Gemini workspace rules and a non-sensitive memory revision number used as trace metadata.

A failed or quota-exhausted Google fallback does not trigger a paid provider and does not hide the original OpenAI terminal failure.

## Operational result

This is a third availability curtain, not a route promotion:

`deterministic fast path when eligible → OpenAI Sol → OpenAI Luna → Google Gemini Free answer-only`

The normal preferred provider remains OpenAI. Google fallback success does not promote Google to primary.

## Rollback

Remove the provider-fallback hook registrations from the mobile plugin and the `--provider-fallback` wrapper mode, rebuild/reinstall the previous plugin revision, then restart/reload the OpenClaw runtime. No durable conversation or capability state is owned by this fallback.
