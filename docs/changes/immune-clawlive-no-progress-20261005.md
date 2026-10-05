# Immune / Claw Live no-progress recovery — 2026-10-05

## Incident

Claw Live exposed a persistent Immune loop for the boot-scoped ADB incident `0647a9e2f1511fe62dfc`. The canonical incident remained in `diagnosing` while Autonomous Engineering returned `budget_exhausted` every few seconds. The worker treated any syntactically valid shadow result as a successful diagnosis, so the incident never reached a bounded terminal or waiting state.

At the same time the permanent Claw Live service snapshot reported `missing=tier0`. The Tier-0 watchdog was installed but absent from the process table; the Root Guardian supervised Health Manager and Incident Orchestrator, but not the Tier-0 watchdog itself.

## Correction

- A fresh canonical `127.0.0.1:5556` ADB proof now recovers a stale ADB incident before model work.
- After a validated `diagnostics.collect_more` recommendation, the ADB handler reuses that bounded action for deterministic diagnostic rounds instead of replaying model diagnosis against the same incident budget.
- A syntactically valid but non-success model result is routed through the existing `engineering-incident-result.py` state translator. Rate-limit/availability states therefore wait with the existing bounded retry contract and `budget_exhausted` terminates instead of spinning.
- Root Guardian now ensures the already-existing external Tier-0 watchdog is present. No daemon, database, scheduler or orchestrator is added.

## Impact

Capability impact: none. This restores the existing bounded `immune.supervision.recovery` contract without changing its scope or entrypoints.

Architecture impact: none. Ownership remains unchanged: Incident Orchestrator owns incident state, EngineeringAgentRunner/ModelGovernor own bounded model attempts, Root Guardian owns core liveness, and Tier-0 remains the release/rollback authority.

## Rollback

Revert this change and promote the prior immutable runtime release. The manually restored Tier-0 watchdog can continue running independently.
