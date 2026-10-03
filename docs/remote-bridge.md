# Claw Remote Bridge

## Purpose

Claw Remote Bridge is the transport-independent execution layer used to replace Remote Desktop Commander without moving reasoning away from ChatGPT/Samantha.

Remote Desktop Commander remains the validated fallback/break-glass path. Slack Socket Mode is the live E2E-validated primary interactive transport while healthy.

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
- `stepId`: optional stable execution-step identifier; requires `taskId`. Reusing the same `taskId + stepId` with the same method/params returns the first durable receipt even from another Chat/session, while changed content is rejected.
- `sessionId`: optional ChatGPT/session correlation.
- `method`: RPC method.
- `params`: method parameters.

Implemented methods:
- `ping`
- `request_status`
- `task_status` (compact receipts for a `taskId`, without replaying work)
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

For engineering/multi-session work, `taskId + stepId` is the execution identity above transport-level `requestId`. The same logical step cannot execute twice merely because a new Chat/session generated a new request ID. A changed method or parameter set for the same task step fails closed with `task_step_conflict`. A deliberate retry after a classified failure must use a new step ID only after the task-level retry guard authorizes another execution.

`task_status` returns bounded receipt metadata for one task (state, hashes/timestamps, risk, process ID) rather than raw outputs. It is the resume view used before deciding whether to observe, continue, revalidate, or submit another step.

A request left `running` by a previous Bridge instance becomes `indeterminate` after restart. The caller must verify the effect before retrying. This is the key guard against duplicate mutations during Slack→Commander fallback.

Large results are persisted under `~/.openclaw/remote-bridge/artifacts/` and returned as an artifact reference plus preview.

Long-running interactive work should use `process_start` followed by bounded `process_status` reads instead of one long `exec_wait`. Lack of stdout is not a stuck signal: an owned silent process remains `running`. If a process receipt says `running` but the current Companion instance no longer owns that process after restart/loss of process ownership, `process_status` persists `indeterminate`; mutations must then be effect-verified before any retry.

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

For malformed plain `CLAW_RPC_V1` envelopes, the adapter now returns a bounded machine-actionable error with `action=use_b64`. This is a transport-format hint only: it does not retry the request. The caller must use `CLAW_RPC_V1_B64` for quoting-heavy/complex payloads and must still honor the same request/status-before-retry idempotence contract for mutations.

After the Slack app has been created and authorized, run `installer/termux-lite/claw-slack-setup.sh` directly in Termux. It prompts locally for channel/user IDs and the two tokens, hides token input, writes secrets with mode 0600, configures `shadow` mode and starts the adapter. Tokens must never be pasted into ChatGPT.

Slack app bot scopes in the initial public-channel design:
- `channels:history`
- `chat:write`

Socket Mode also requires an app-level token with `connections:write` created in Slack. Do not paste that token into ChatGPT.

## Supervision

Health Manager starts the Slack bridge only after complete local config and secret files exist.

Missing configuration is `setup_required`, not a failure. Once configured, the adapter owns WebSocket reconnect with exponential backoff. Health Manager restarts the process if it disappears and records persistent local startup failure.

## Slack control-channel housekeeping

`installer/termux-lite/claw-slack-purge.mjs` is a small hourly housekeeping task for the dedicated control channel only. It has no database and no daemon.

Rules:
- only `CLAW_RPC_V1` parents with a local Remote Bridge receipt are considered;
- messages younger than 24 hours are never touched;
- receipts still `running`, `indeterminate`, `received` or `pending` are retained;
- all thread replies must also be older than the TTL;
- bot replies are deleted with the existing bot token, then the ChatGPT/owner parent is deleted with a scoped Slack user token;
- missing/already-deleted messages are treated idempotently;
- API failure on one transaction does not make another transaction eligible;
- the log contains counters only and is bounded to the most recent 200 summary lines.

The extra user token is required because Slack channel-thread reads and owner-message deletion cannot be completed with the bot identity alone. The app manifest therefore requests only `channels:history` and `chat:write` as user scopes in addition to the existing bot scopes. The token is stored locally with mode 0600 and is never committed.

`claw-slack-purge-setup.sh` stores the user token, performs a dry-run, and installs one OpenClaw command job with declaration key `samantha:slack-control-purge` every hour.

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

Local Bridge performance benchmark on the production Companion (2026-09-29):
- 120 sequential pings: p50 4.482 ms, p95 5.883 ms, max 6.939 ms.
- 100 requests with 10 workers: 328.101 ms wall time, ~304.78 RPC/s, p50 30.577 ms, p95 38.694 ms.
- production checks also passed idempotent write, request-id conflict, read, exec, process streaming and a 70,187-byte artifact.

Slack resilience simulation also passed:
- HTTP 429 + Retry-After is retried without losing the queued result;
- Slack disconnect triggers bounded automatic Socket Mode reconnect;
- a second RPC succeeds on the new connection and adapter health returns healthy.

Live Slack provider acceptance is now complete for the interactive chain. Twelve real pings measured Slack parent-message to Bridge thread-reply latency at min 345.17 ms, p50 571.52 ms, p95 3938.20 ms and max 3938.20 ms. The light-command p95 target (<5 s) passed. A real screen-off + locked-device ping also passed in 1268.88 ms and the device was restored to its initial awake/unlocked state.

## Promotion / resilience status

The live ChatGPT↔Slack↔S24↔ChatGPT chain is promoted for primary interactive use while healthy:
- ChatGPT writes and reads the dedicated `#claw-control` channel: PASS;
- S24 receives and executes correlated RPCs: PASS;
- ChatGPT reads the result and chooses a second RPC in the same workflow: PASS;
- live latency sample p50/p95 target: PASS;
- locked/screen-off state: PASS;
- active idempotent write verified independently by Remote Desktop Commander: PASS.

Wi-Fi↔mobile transition remains a resilience follow-up because no known Wi-Fi network was available during acceptance. A guarded attempt temporarily enabled Wi-Fi, observed `Wifi is not connected`, then restored the exact pre-state (`wifi_on=0`, mobile data on, airplane mode off) and revalidated connectivity. Do not retire Remote Desktop Commander as fallback/break-glass before this transition test can be completed.

## Live provider evidence

- Ping `chatgpt-e2e-1790681152756` completed on S24 and returned in its Slack thread in 651.84 ms.
- ChatGPT read that response, reasoned on `pong=true`, then sent `chatgpt-e2e-read-1790681221519`; S24 returned the real Slack health file through the second Slack thread.
- Active write `chatgpt-e2e-write-1790681337196` completed in 575.60 ms. Desktop Commander verified exact content and SHA-256 `5fcbe88fbba4f415defbdc4b689a14eb6fd9fd251647023e774add4ecee45573`. Reposting the exact same request ID returned the original stored completion without a second write. The test artifact was removed.
- Twelve additional live pings: min 345.17 ms, p50 571.52 ms, p95/max 3938.20 ms.
- Locked-screen ping `locked-ping-1790681928378` completed while the phone reported `Asleep`, keyguard showing and `deviceLocked=1`; parent→reply 1268.88 ms.

### Slack control-channel housekeeping acceptance — 2026-09-29

The housekeeping path is live and intentionally small: one script, one existing OpenClaw hourly command job, no database and no daemon.

Acceptance:
- fixture suite passes TTL, completed-vs-running/indeterminate, foreign human reply protection, user-token absence, already-missing/idempotent deletion and parent/reply identity split;
- real 24-hour dry-run on `#claw-control` completed with no eligible messages and no errors;
- disposable live RPC `purge-live-final-1790686658880` produced one Claw Bridge reply, then a TTL=0 acceptance run deleted exactly one parent and one bot reply with `failed=0`; exact Slack search returned no result afterward;
- the installed OpenClaw job `samantha:slack-control-purge` was force-run with its normal 24-hour TTL and completed `status=ok` in 867 ms with zero eligible messages;
- the purge log stores counters only and is capped to the most recent 200 lines.

The Slack user token is stored locally mode 0600 and is used only for public-channel thread reads and deletion of ChatGPT/owner parent messages. Bot replies use the existing bot token.
- simulated Slack API unavailability fails the purge cycle without deleting any message; the existing hourly scheduler provides the next retry.

## Reply truncation repair — 2026-10-03
Results between the adapter's 26,000-character threshold and the core's 48-KiB artifact threshold used to lose stdout, exitCode and stderr in compactReply. The adapter now includes a real bounded preview, execution metadata, stderrPreview and truncated=true. The complete local receipt is unchanged. A completed RPC with truncated=true is not a transport outage; recover its stored result instead of replaying execution.

Use small file ranges and intent-specific projections. For artifacts, call artifact_read with a bounded maxBytes such as 6000. Large context concatenation increases connector/model work and should not be on a warm balance request path.

CLAW_RPC_V1_B64 means base64url without padding (Node: Buffer.from(JSON.stringify(payload),"utf8").toString("base64url")). Standard Base64 containing + or / is not this envelope. Use plain JSON only for simple payloads that do not depend on Markdown-sensitive punctuation.

The regression sends an inline stdout above 33,000 characters with exitCode 7 and stderr KNOWN_ERROR, verifies the useful compact reply and confirms the full receipt remains readable. Existing owner filtering, shadow-mode, idempotence, 429 and reconnect tests pass.

Paired latency analysis and measured results: samantha-ui-playbooks/telecom/BALANCE_LATENCY_AUDIT_20261003.md.
