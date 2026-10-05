# ADB recovery readiness standby semantics — 2026-10-05

## Problem

Canonical ADB could remain healthy on `127.0.0.1:5556` while Samsung reset `adb_wifi_enabled=0`. The proactive recovery-readiness probe then reported a degraded state, incremented its readiness failure counter and attempted to re-enable Wireless Debugging even though the primary ADB capability was fully operational.

The previous 2026-10-05 mitigation stopped known proactive readiness reasons from opening a blocking incident, but it still produced unnecessary churn and did not represent the distinction between current service availability and future recovery readiness precisely.

## Change

- `adb-recovery-readiness.py` now returns `standby` when canonical ADB is verified but Wireless Debugging is disabled, Wi-Fi recovery is not armed, or no trusted dynamic endpoint is discoverable.
- `standby` has `requires_owner_action=false` and exits successfully.
- `adb-recovery-watchdog.sh` resets readiness failures in standby and does not toggle Wireless Debugging or open `human_required`.
- Historical known degraded advisory reasons are normalized to standby for rolling compatibility.
- A stale readiness-specific incident/marker is recovered and superseded when primary ADB is independently healthy; no recovery notification is sent merely for entering standby.
- `health-verdict.py` accepts `standby` as the explicit non-critical advisory state.
- The primary ADB recovery path is unchanged: if canonical ADB is actually lost, bounded deterministic recovery still runs and can escalate through the existing ADB incident path only after exhaustion.

## Capability impact

Modified behavior of existing capability `device.adb.recovery_readiness`. No new capability, daemon, scheduler, database, Android permission or recovery owner is added.

## Architecture impact

None. Canonical ADB remains owned by `device.adb`; the existing readiness helper/watchdog remain the sole recovery-readiness owner.

## Validation

Targeted deterministic tests cover:
- canonical ADB unavailable;
- Wireless Debugging disabled while primary ADB is healthy;
- Wi-Fi-off standby while primary ADB is healthy;
- trusted endpoint ready;
- missing endpoint standby;
- old degraded advisory compatibility;
- standby failure counter reset;
- no readiness human escalation while primary ADB is healthy;
- stale readiness-marker supersession;
- health verdict standby acceptance.

Live validation after deployment must show canonical ADB healthy, readiness `standby`, readiness failures `0`, no active readiness incident, and overall Immune health healthy.

## Rollback

Promote the prior Tier-0 Last Known Good release and revert the source commit. Standby state files are safe to leave in place; the prior runtime will reinterpret unsupported state as unverified until the next probe.
