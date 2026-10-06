# OpenClaw / RDC self-heal hardening — 2026-10-06

## Incident

OpenClaw became unavailable after a valid source-side `voiceBargeIn` configuration was written before the corresponding plugin manifest was installed. Companion retries could not pass configuration validation. After plugin reconciliation, state migration was blocked by gateway locks owned by PID 4268 even though that process no longer existed. On Android/Termux, Node `process.kill(pid, 0)` returned `EPERM`, so OpenClaw conservatively treated the stale owner as potentially alive and did not reclaim the lock.

During recovery, Remote Desktop Commander also became unavailable. Its local MCP started correctly and curl reached the remote endpoint with HTTP 200, but the same Node 24 runtime used by RDC timed out. Launching the existing RDC watchdog with IPv4-first DNS ordering restored the remote heartbeat. The existing half-open loop could then retry too aggressively because its timing state did not survive watchdog restarts.

## Correction

- Gateway startup validates configured mobile-plugin keys against both canonical source and installed manifests before OpenClaw starts.
- A stale installed plugin schema is reconciled only from a clean canonical plugin source; unknown source-side keys or dirty source fail closed.
- OpenClaw configuration validation is mandatory after reconciliation.
- Android stale gateway locks are quarantined, never deleted blindly, only after exact lock identity, PID/start identity, process table and port checks prove no live gateway owns them. Ambiguous ownership fails closed.
- If gateway startup then returns the explicit `gateway.maintenance_required` marker, Companion executes the supported `openclaw doctor --fix --non-interactive` path with a 60-second timeout, at most two attempts, refuses any remaining gateway process ownership, and retries startup once. Other failures are not rewritten as maintenance.
- RDC launches its existing Node runtime with IPv4-first DNS ordering scoped to the RDC child only.
- RDC half-open dependency probes use that same Node/fetch stack rather than a different curl/Python network path.
- RDC half-open retry state is persisted by the existing controller with bounded exponential backoff, so restarting the watchdog cannot reset an exhausted circuit.

## Ownership and architecture

No new daemon, scheduler, router, database, incident engine or source of truth is introduced. Companion remains gateway recovery owner, Health Manager remains observer/escalation owner, the existing RDC controller/watchdog owns RDC repair, and Tier-0 remains immutable release/rollback authority.

Existing capabilities are strengthened without changing their public entrypoints: `device.remote_desktop` and `immune.supervision.recovery`. The external MCP owner primitives `claw_context`, `claw_resolve`, `claw_execute`, `claw_exec`, `claw_status` and `claw_artifact_read` have no schema or execution-contract impact from this change.

## Verification before deployment

- Gateway preflight tests: 8/8 passed from the self-contained Tier-0 package.
- Companion bounded maintenance recovery deterministic test: passed (already-recovered, live-owner refusal, second-attempt recovery, two-attempt exhaustion).
- RDC controller/watchdog tests: 19/19 passed.
- RDC incident-loop tests: 5/5 passed.
- Shell/Python syntax checks passed.
- Live read-only preflight: plugin schema `ok`; live gateway lock recognized as `active_owner`, therefore not reclaimed.
- Existing runtime restored before source deployment: OpenClaw `/healthz` returned `{"ok":true,"status":"live"}`; gateway deep connectivity probe passed; RDC singleton local MCP + fresh remote heartbeat healthy.

## Runtime activation and live acceptance

- Final source commit: `5e94d8c951177218cbfe61138420af6db342e7f1`.
- Final immutable Tier-0 release: `20261006-openclaw-auto-maintenance-5e94d8c`.
- Tier-0 soak: `stable`, `0` bad samples; the release became Last Known Good.
- Deployed Tier-0 regression: gateway preflight 8/8 PASS; RDC controller/watchdog 19/19 PASS.
- Companion build includes the bounded maintenance-repair function and was restarted through the existing Health Manager; `/v1/health` reports connected, `adb_shell`, gateway reachable.
- OpenClaw `/healthz` remained live through activation. RDC reports singleton functional health with local MCP + fresh remote heartbeat, the same-Node dependency probe succeeds, and an external RDC ping returns pong.
- Slack Remote Bridge health is healthy on the final runtime root.
- MCP owner parity: external MCP bridge contract PASS and `test_mcp_delivery_parity` 2/2 PASS; all six owner primitives remain no-impact.
- No destructive synthetic outage was injected after final activation because other S24 engineering tasks were active. The real incident exercised plugin drift, stale-lock and RDC network recovery; deterministic isolated tests cover the new bounded Doctor path.

## Rollback

Revert the source commit and promote the previous immutable Tier-0 release. Lock recovery evidence remains in OpenClaw backups; the new logic never deletes an ambiguous lock.
