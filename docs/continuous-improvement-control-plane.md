# Continuous Improvement Control Plane

## Components

- `tier0-control.py`: versioned runtime release packaging, promotion, emergency stop and rollback.
- `tier0-watchdog.py`: soak monitor and automatic rollback to Last Known Good.
- `tier0-bootstrap.sh`: boot entry using the active immutable release.
- `install-tier0-control.py`: guarded installation of Tier-0 and Termux:Boot handoff.

Runtime scripts use `CLAW_RUNTIME_ROOT` so a packaged release executes its own copy instead of falling back to the mutable development checkout.

## Safety contract

Tier 0 is not in any Autonomous Engineering writable profile. It controls whether model-backed auto-repair is allowed. A release hash mismatch refuses activation. Promotion is atomic through symlink replacement.

During soak, two consecutive unhealthy samples from declared critical capabilities trigger rollback and core restart. Successful soak advances Last Known Good.

## Recovery

The previous Termux boot script is preserved as `start-samantha.pre-tier0`. Manual recovery can use the Tier-0 control command to stop Autonomous Engineering or rollback the release.

## Closed Loop Autonomy — 2026-10-01

The control plane now closes the existing Learning Gate → Improvement → Preflight path without adding a daemon, scheduler, database or orchestrator. Reusable closure learnings use the canonical Skill Intelligence candidate type (`rule`) plus `learning_type=closure_learning` and are ingested immediately by `learning-gate-close.sh`; the 13:05 Dreaming bridge remains the idempotent reconciliation/backfill path. Legacy closure types remain accepted by Skill Intelligence so existing pending proposals can be recovered.

Engineering Maintenance publishes semantic health separately from process exit. `health-verdict.py` exposes this as `control_plane.maintenance`: a healthy cron with an unhealthy internal pipeline is therefore `degraded`, but does not trigger an automatic cron retry loop. Tier 0 and its rollback/kill-switch boundaries remain unchanged and outside model-writable profiles.
