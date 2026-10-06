# OpenClaw / RDC self-heal hardening — 2026-10-06

## Incident

OpenClaw became unavailable after a valid source-side `voiceBargeIn` configuration was written before the corresponding plugin manifest was installed. Companion retries could not pass configuration validation. After plugin reconciliation, state migration was blocked by gateway locks owned by PID 4268 even though that process no longer existed. On Android/Termux, Node `process.kill(pid, 0)` returned `EPERM`, so OpenClaw conservatively treated the stale owner as potentially alive and did not reclaim the lock.

During recovery, Remote Desktop Commander also became unavailable. Its local MCP started correctly and curl reached the remote endpoint with HTTP 200, but the same Node 24 runtime used by RDC timed out. Launching the existing RDC watchdog with IPv4-first DNS ordering restored the remote heartbeat. The existing half-open loop could then retry too aggressively because its timing state did not survive watchdog restarts.

## Correction

- Gateway startup validates configured mobile-plugin keys against both canonical source and installed manifests before OpenClaw starts.
- A stale installed plugin schema is reconciled only from a clean canonical plugin source; unknown source-side keys or dirty source fail closed.
- OpenClaw configuration validation is mandatory after reconciliation.
- Android stale gateway locks are quarantined, never deleted blindly, only after exact lock identity, PID/start identity, process table and port checks prove no live gateway owns them. Ambiguous ownership fails closed.
- RDC launches its existing Node runtime with IPv4-first DNS ordering scoped to the RDC child only.
- RDC half-open dependency probes use that same Node/fetch stack rather than a different curl/Python network path.
- RDC half-open retry state is persisted by the existing controller with bounded exponential backoff, so restarting the watchdog cannot reset an exhausted circuit.

## Ownership and architecture

No new daemon, scheduler, router, database, incident engine or source of truth is introduced. Companion remains gateway recovery owner, Health Manager remains observer/escalation owner, the existing RDC controller/watchdog owns RDC repair, and Tier-0 remains immutable release/rollback authority.

Existing capabilities are strengthened without changing their public entrypoints: `device.remote_desktop` and `immune.supervision.recovery`. The external MCP owner primitives `claw_context`, `claw_resolve`, `claw_execute`, `claw_exec`, `claw_status` and `claw_artifact_read` have no schema or execution-contract impact from this change.

## Verification before deployment

- Gateway preflight tests: 7/7 passed.
- RDC controller/watchdog tests: 19/19 passed.
- RDC incident-loop tests: 5/5 passed.
- Shell/Python syntax checks passed.
- Live read-only preflight: plugin schema `ok`; live gateway lock recognized as `active_owner`, therefore not reclaimed.
- Existing runtime restored before source deployment: OpenClaw `/healthz` returned `{"ok":true,"status":"live"}`; gateway deep connectivity probe passed; RDC singleton local MCP + fresh remote heartbeat healthy.

## Rollback

Revert the source commit and promote the previous immutable Tier-0 release. Lock recovery evidence remains in OpenClaw backups; the new logic never deletes an ambiguous lock.
