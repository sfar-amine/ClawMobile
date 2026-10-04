# RDC recovery hardening — 2026-10-04

## Incident
At 05:44:50 +01 the existing functional probe classified RDC as `remote_channel_unhealthy`. The local Desktop Commander MCP remained able to start, while the remote process logged heartbeat timeout/reconnect failures and `fetch failed` toward `https://mcp.desktopcommander.app`. In the same 05:45–05:49 window WhatsApp, Slack Bridge and SMTP also degraded. Slack recovered at 05:55:29 and SMTP at 05:57:20. No new Android `LOW_MEMORY` exit exists for Termux; the last such exit remains 2026-10-03 18:10:38.640. The verified classification for this occurrence is therefore a transient outbound/external dependency incident affecting several network consumers. The lower-level radio/carrier/routing trigger is not proven.

## Why self-healing stopped
The RDC controller correctly executed two serialized restart attempts and cleaned each failed process. Both happened while the remote dependency was still unavailable. It then opened the circuit and left no RDC process running. The open-circuit branch reconciled the incident but had no half-open probe, so later network recovery could not relaunch RDC.

The model-assisted second line also diverged from its documented contract. `skill_intelligence.cli diagnose`, which is the production entrypoint used by `autonomous-engineering-shadow.sh`, restricted `allowed_models` to Sol and Luna even though the governor/runner policy includes the bounded Google Free third curtain. The RDC shadow wrapper additionally limited the incident to two calls. The live incident consequently stopped on Luna `rate_limit` although Google Free was not cooling down.

Finally, a verified service return after the incident had already reached terminal `failed` could not be published as `RECOVERED`: the orchestrator refused recovery from a failed episode. That prevented canonical recovery fan-out even when the component later became healthy.

## Correction
- Keep the existing RDC circuit breaker, controller, watchdog and Incident Orchestrator; add no service, scheduler, database or parallel recovery engine.
- While the circuit is open, perform a bounded anonymous HEAD reachability probe to the existing RDC remote endpoint every 60 seconds. An unreachable dependency causes no restart. Reachability only authorizes one call to the existing serialized bounded `repair()` primitive; it is not a health proof.
- Keep health fail-closed: only one process plus fresh process-bound local MCP ping and joined remote heartbeat can close the circuit. External ChatGPT RDC ping remains a separate E2E acceptance proof.
- Preserve failed incident history. A later verified recovery creates a new recovery episode linked by `recovery_after_failed`; the existing continuation link (capability/run/ledger) is inherited onto that episode before `recovered`, so the existing recovery dispatcher can resume blocked work without rewriting the failed incident.
- Use the existing four-call incident ceiling for RDC. This leaves enough room for a diagnostic evidence round followed, if required, by Sol → Luna → Google Free availability fallback. No budget is increased beyond `model_policy.json`.
- Align the production CLI allowlist with the already-approved Google Free provider fallback; provider identity/cost/tool-free gates remain unchanged.
- Realign one stale runtime contract test from the removed `grep -Fx` implementation to the already-live exact `/proc/<pid>/cmdline` argument comparison. No runtime behavior is changed by that test correction.

## Validation before activation
- 66 focused Python runtime tests across health verdict, Tier0, Learning Gate, supervisor locks, continuation, Slack runtime contract, incident orchestrator, RDC watchdog, engineering runtime bridge and real isolated RDC incident loop: PASS.
- `test-incident-runtime-hardening.sh`: PASS (`whatsapp owner send: OK`, `incident runtime hardening: OK`).
- `test-remote-desktop-health.mjs`: PASS, 9 assertions.
- UI/engineering targeted provider tests: PASS.
- Full Samantha UI Playbooks regression on the final frozen candidate: 832 tests, PASS.
- During this correction the old runtime reproduced a second partial RDC failure: device presence remained Online while external ping timed out. The unchanged managed repair restored one healthy instance in 17.621 s and the external ping then succeeded. This is live recurrence evidence for the half-open gap; it is not acceptance of the candidate until immutable activation.

## Rollback
Promote the previous verified immutable Tier0 release and retain incident/model receipts. Revert only the scoped runtime commit and the corresponding UI documentation/CLI commit after checking concurrent changes. Historical failed incidents are never deleted.
