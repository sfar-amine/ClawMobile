# Claw Live + Bixby capability bridge — 2026-09-30

## Architecture
- Claw Live uses Google Gemini 3.8 Live on demand and exposes exactly one generic tool: `clawmobile_capability`.
- `claw_live` is distinct from the Google Gemini app Live surface; it must not inherit private Google Connected Apps.
- Bixby uses a single private `Claw` capsule, a minimal Cloudflare Worker/Durable Object relay, and one outbound WebSocket owned by the existing Companion process.
- The canonical Capability Graph remains on S24. The relay has no business logic and no capability registry.

## Performance/lifecycle
- No model runs permanently.
- No new daemon.
- Bixby relay heartbeat defaults to 45 s and reconnects on socket failure with bounded exponential backoff.
- Repeated requestIds are deduplicated on both relay and S24.
- Deterministic read routes are executed before an agent fallback.

## Security
- Google long-lived API key remains in OpenClaw secret storage; the browser Claw Live surface receives only one-use ephemeral Live tokens.
- The Bixby relay uses separate owner/device bearer secrets, never committed to Git.
- Companion remains loopback-only.

## External gates
- Cloudflare Worker deployment requires an authenticated Cloudflare account. No account is currently configured on the S24.
- Bixby live acceptance requires owner-linked Samsung/Bixby Developer Studio testing. The studio is not installed/configured on the S24.
- Until those two external gates are satisfied, `bixby_claw` is locally implemented/recettable but must not be represented as externally live.

## Live evidence
A real Gemini 3.8 Live canary invoked `clawmobile_capability`, selected `telecom.orange.consultation` / `orange.silent_first.balance`, returned the bounded counter clarification, produced 24 kHz PCM audio, and completed in about 6.7 s end to end.
