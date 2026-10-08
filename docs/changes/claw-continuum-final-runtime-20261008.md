# Continuum final runtime — 2026-10-08

## Scope

This runtime delivery completes the Companion side of CLAW CONTINUUM Lots 8, 9, 10 and 12 without adding a second business router.

### MCP

`claw_execute` now resolves the canonical Capability Graph first. When the shared Graph classifies the action `durable`, the existing MCP `action_key/taskId/step_key` identity is admitted into the S24 Continuum ledger before Remote Bridge submission.

Durable writes receive the persisted Continuum fence. Durable reads use the same Mission without a fence. Existing receipts are observed, never resubmitted. `claw_status` projects Continuum status when such a Mission exists. Fast reads retain the prior direct path.

### Capability-First

The owner Capability-First ingress reuses its existing stable `origin_id`. Durable non-human-boundary executions are sent through the existing Remote Bridge using `capability_execute_readonly/owner`, so the Bridge is the real effect boundary. A response-loss path performs one status lookup and never a second submit.

Human confirmation workflows keep their existing owners and inert pre-model handoff; this delivery does not replace PaymentRecord, biometrics or issuer return logic.

### Control

The existing Samantha Control facade accepts the read-only `missions` section and detail route. It reads the S24 projection produced by `reporting.control_snapshot`; the Companion stores no Mission truth.

## Tests

- TypeScript build PASS.
- MCP bridge PASS, including durable write/read/status and fast-read compatibility.
- generic capability Bridge PASS for read, fenced write and stale epoch rejection.
- Capability-First durable orchestration PASS, including response loss with exactly one submit and status recovery.
- historical Capability-First plugin tests PASS.
- Control V2 PASS with Missions endpoint.
- Remote Bridge core/Slack/resilience remain separately regression-tested in the S24 final gate.

## Activation

`deployment_state=not_applied` until the exact private runtime commit is published, built and the supervised Companion has restarted. Live final acceptance must run after activation.

## Activation verified
Published commit `a69e74add647c8a60da9ffbfde47c33e95eb3b37` is active in supervised Companion PID `14409`, health `healthy`. Final response-loss read/write acceptance passed after activation.
