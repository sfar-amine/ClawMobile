# ADR — ChatGPT ↔ S24 dual transport with local Claw Bridge

- Date: 2026-09-29
- Status: Accepted for implementation; Slack transport remains experimental until live E2E acceptance.
- Decision owner: Amine / Claw.

## Context

Remote Desktop Commander currently provides the direct ChatGPT-to-S24 filesystem and shell path. It is reliable and fast, but the free tier is quota constrained. A temporary paid month is active while an equivalent durable path is built.

Measured Remote MCP load is materially higher than a notification workload: 11,645 calls over four usage days, with a recent active average of about 186 calls/hour and observed peaks of 3 calls/s, 11 calls/10 s and 34 calls/min.

Samantha in ChatGPT must remain the primary reasoning/orchestration plane. The S24 must not become the default planner for engineering tasks.

## Decision

Introduce a transport-agnostic local Claw Bridge inside the existing Companion server.

The Bridge is an executor, not a planner. It accepts correlated RPC requests with stable requestId, executes bounded local operations, persists receipts, streams or artifacts large results, and returns deterministic status/result data.

Use two control transports in active/passive mode:

1. New real-time transport, initially Slack Socket Mode, becomes primary only after live E2E acceptance.
2. Remote Desktop Commander remains fallback/break-glass and independent validation path while available.

Both paths converge on the same Bridge where possible. This preserves request identity and process state across transport failover.

No mutating request is blindly replayed. A repeated requestId returns its prior receipt. A running receipt from a previous Bridge instance becomes indeterminate; the caller must verify the effect before retrying.

## Why Slack first

Slack Socket Mode gives an outbound-only persistent WebSocket from the S24, requires no public S24 endpoint, and has sufficient inbound event capacity for the measured load when low-level polling is consolidated locally.

Slack is only a control plane. Large outputs are stored as Bridge artifacts and fetched in bounded chunks.

## Fallback semantics

- Reads may be shadowed through Remote Desktop Commander for comparison.
- Writes execute on one path only.
- On primary timeout, query the same requestId before any fallback execution.
- completed: recover the stored result.
- running: continue observing.
- indeterminate: verify effect explicitly; never replay automatically.
- not found: the fallback may submit the same request.
- Return to the primary transport only after repeated healthy probes.

## Performance targets

- Transport ACK target: under 2 s.
- Lightweight complete command target: under 3–5 s.
- Evaluate p50/p95.
- Primary transport capacity target: several thousand RPC/day and at least 5 RPC/s burst capability.

## Security

The Companion Bridge endpoints remain loopback-only.

The Slack adapter:
- uses Socket Mode outbound from the S24;
- accepts messages only from one configured channel and explicit Slack user allowlist;
- defaults to shadow, where mutating methods are rejected;
- reads secrets from runtime environment or chmod-600 files outside Git;
- never stores credentials in documentation or repository files.

## Consequences

Positive:
- ChatGPT remains the brain.
- Transport can be replaced without rewriting S24 execution logic.
- Desktop Commander can validate and repair the new transport.
- Polling and process waits can be collapsed locally, reducing control-plane traffic.
- Failover is idempotent and fail-closed.

Costs:
- One additional optional supervised Slack adapter process when configured.
- Slack credentials and ChatGPT Slack connection require explicit user authorization.
- Live ChatGPT↔Slack↔S24↔ChatGPT round-trip remains to be accepted before primary promotion.

## Validation evidence

Local isolated acceptance already covers:
- request persistence and idempotent writes;
- request-id conflict detection;
- exec and long-running process output;
- artifactization of large results;
- stale/running request fail-closed behavior;
- Slack Socket Mode envelope ACK;
- owner/channel filtering;
- shadow mutation rejection;
- duplicate Slack delivery without duplicate write;
- local Bridge benchmark p50/p95 and burst throughput.

Live provider acceptance is intentionally separate.
