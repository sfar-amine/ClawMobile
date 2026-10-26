# Parked incidents get a bounded review — 26 October 2026

On 26/10 the S24 had seven active incidents in `awaiting_deterministic_recovery`, with `next_retry 0` and no human boundary. Three were route incidents waiting since 17-20/10: Orange summary and USSD, and Pulse collaborator. That state only leaves through a health-manager verification. Nothing reviewed it, and nobody was told.

- `incident-orchestrator.py escalate-stale`: an incident in `awaiting_deterministic_recovery` with no activity for 24 h moves to `human_required` through the existing transition, and one notice is queued with `incident-notify.sh`. The notice is deduplicated by content, and the new state takes the incident out of the selection. Incidents that have an immune intervention are left to its own review, which escalates them itself, so no double notice. A later verified recovery still closes it (`human_required → verifying → recovered`).
- `incident-orchestrator-worker.sh` runs that review inside its existing loop every 5 min (injectable for tests). No new daemon or scheduler.
- `health-verdict.py`: the `incident_live_mismatch` warning now uses `_incident_component_live_state`, the same resolver as recent failures, so namespaced capabilities and the Slack bridge receipt are recognized.

Tests: 2 new orchestrator tests and 1 new health-verdict test. The incident, immune and RDC suites pass. Rollback: revert this commit.
