# Claw Remote Bridge

## Purpose

Claw Remote Bridge is the transport-independent execution layer used to replace Remote Desktop Commander without moving reasoning away from ChatGPT/Samantha.

Remote Desktop Commander remains the validated fallback/break-glass path. Slack Socket Mode is the first experimental primary transport.

## Runtime topology

ChatGPT/Samantha → transport router → Slack primary or Remote Desktop Commander fallback → Companion Remote Bridge → Termux / files / process / ADB / OpenClaw.

The Bridge runs inside the existing ClawMobile Companion HTTP server and remains loopback-only.

## Protocol

Base path: `/v1/extensions/remote-bridge`.

Routes:
- `GET /health`
- `POST /requests`
- `GET /requests/:requestId`

Request body fields:
- `requestId`: stable idempotency key, mandatory.
- `taskId`: optional higher-level task correlation.
- `sessionId`: optional ChatGPT/session correlation.
- `method`: RPC method.
- `params`: method parameters.

Implemented methods:
- `ping`
- `request_status`
- `exec_wait`
- `read_file`
- `write_file`
- `artifact_read`
- `process_start`
- `process_status`
- `process_input`
- `process_stop`

## Idempotence and failover

A request receipt is persisted under `~/.openclaw/remote-bridge/requests/`.

Submitting the same `requestId` with the same method and parameters returns the existing receipt. Reusing the ID with different content is rejected with `request_id_conflict`.

A request left `running` by a previous Bridge instance becomes `indeterminate` after restart. The caller must verify the effect before retrying. This is the key guard against duplicate mutations during Slack→Commander fallback.

Large results are persisted under `~/.openclaw/remote-bridge/artifacts/` and returned as an artifact reference plus preview.

Long-running interactive work should use `process_start` followed by bounded `process_status` reads instead of one long `exec_wait`.

## Desktop Commander fallback

`installer/termux-lite/claw-bridge-cli.py` calls the same local Bridge.

Examples:
- `claw-bridge-cli.py health`
- `claw-bridge-cli.py status REQUEST_ID`
- `claw-bridge-cli.py submit --request-id ID --method ping --params-json '{}'`

Fallback procedure:
1. If the primary transport times out, query the same request ID first.
2. If completed, recover the stored result.
3. If running, continue observing.
4. If indeterminate, verify the external effect before any retry.
5. Only if the request is absent may the fallback submit it.

## Slack adapter

`installer/termux-lite/claw-slack-bridge.mjs` uses Slack Socket Mode with Node 24 built-in WebSocket/fetch.

Security gates:
- exact channel ID;
- explicit Slack user allowlist;
- bot messages ignored;
- default mode is `shadow`;
- in shadow mode only read-only methods are accepted;
- secrets are read from environment or chmod-600 runtime files and are never committed.

Default runtime paths:
- config: `~/.openclaw/remote-bridge/slack/config.json`
- app token: `~/.openclaw/remote-bridge/slack/secrets/app-token`
- bot token: `~/.openclaw/remote-bridge/slack/secrets/bot-token`
- health: `~/.openclaw/remote-bridge/slack/health.json`

The example config and Slack app manifest are shipped next to the installer scripts.

Slack app bot scopes in the initial public-channel design:
- `channels:history`
- `chat:write`

Socket Mode also requires an app-level token with `connections:write` created in Slack. Do not paste that token into ChatGPT.

## Supervision

Health Manager starts the Slack bridge only after complete local config and secret files exist.

Missing configuration is `setup_required`, not a failure. Once configured, the adapter owns WebSocket reconnect with exponential backoff. Health Manager restarts the process if it disappears and records persistent local startup failure.

## Acceptance evidence — 2026-09-29

Core functional test passed:
- idempotent append write;
- request-id conflict;
- exec_wait;
- process start/status streaming;
- large-result artifact;
- stale running request fails closed as indeterminate.

Slack simulated E2E test passed:
- Socket Mode open;
- envelope ACK;
- owner/channel filter;
- shadow mutation rejected;
- active write completed;
- duplicate Slack delivery did not duplicate the write;
- unauthorized Slack user ignored;
- adapter health healthy.

Manual real crash test passed: a running request interrupted by killing the Companion process was reported `indeterminate` after restart.

Local Bridge performance benchmark:
- 250 sequential pings: p50 5.06 ms, p95 7.31 ms, max 70.51 ms.
- 100 requests with 10 workers: 386.4 ms wall time, ~258.8 RPC/s, p50 33.9 ms, p95 44.47 ms.

These numbers measure the local Bridge only, not Slack provider latency.

## Promotion gate

Slack must not replace Desktop Commander as primary until a live ChatGPT↔Slack↔S24↔ChatGPT test verifies:
- ChatGPT can write the dedicated Slack channel;
- S24 receives and executes the RPC;
- ChatGPT can read the result in the same interactive turn/workflow;
- p50/p95 latency targets are met;
- Wi-Fi/mobile transition and reconnect pass;
- locked/screen-off state passes;
- at least one shadow read comparison matches Remote Desktop Commander;
- one idempotent write is independently verified by Remote Desktop Commander.

Until then Slack remains experimental and Desktop Commander remains primary.
