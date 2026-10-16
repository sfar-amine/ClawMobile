# OpenAI → Google Free native provider fallback

## Canonical route

The main agent uses OpenClaw's native provider chain:

1. the owner-selected OpenAI primary;
2. `openai/gpt-5.6-luna`;
3. `google/gemini-3.5-flash-lite@google:claw-gemini-free`.

The scoped configuration patch is
[`config/samantha-provider-fallback.json`](config/samantha-provider-fallback.json).
It does not replace the primary model, widen the allowed model set, or change any
other agent. Native session history, retries, tool execution and refusal semantics
remain owned by OpenClaw.

The former WhatsApp plugin recovery path was removed because its Gateway hooks do
not run on the deployed OpenClaw version. Keeping it would duplicate the native
Google attempt and create a second owner for provider fallback behavior.

## Verification

`openclaw-plugin-mobile-ui/scripts/test-native-provider-fallback.cjs` verifies that
the patch is limited to `main`, preserves the owner-selected primary, and pins the
last native fallback to the named free Gemini profile. The check runs in the
repository CI workflow.

## Boundaries

This configuration does not change the dedicated Gemini agent or the HS8 voice
memo transcription pipeline. Those paths keep their existing provider policy,
retry registry and runtime contracts.

## Rollback

Restore the previous `main.model.fallbacks` configuration with the existing
OpenClaw configuration owner. No plugin hook, durable state, conversation or
capability state is owned by this fallback.
