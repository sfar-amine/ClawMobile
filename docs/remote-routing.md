# ChatGPT to S24 remote routing

## Active policy

Slack Remote Bridge is the primary substantive ChatGPT-to-S24 RPC transport after the live E2E promotion on 2026-09-29. Remote Desktop Commander is fallback/break-glass and the independent repair path.

The mandatory ChatGPT Claw session bootstrap/read barrier may still use Remote Desktop Commander when required by the bootstrap contract. That exception does not promote RDC for substantive work.

## Selection

1. Confirm the ChatGPT Slack connector is exposed.
2. Send a benign `CLAW_RPC_V1` ping to `#claw-control`.
3. If the ping completes, use Slack Remote Bridge for subsequent S24 RPC in that turn/session.
4. If Slack/Bridge is unavailable, degraded, or lacks the required method, record a fallback event with the concrete reason and use RDC.
5. Restore Slack primary only after a fresh benign E2E ping succeeds.

For mutations, keep the same stable requestId and query status before retry. Never execute the same mutation independently on both transports.

Runtime policy: `~/.openclaw/remote-bridge/route-policy.json`.
Runtime helper: `claw-route status` and `claw-route event ...`.
