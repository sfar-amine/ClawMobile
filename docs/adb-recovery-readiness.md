# ADB recovery readiness

## Purpose

Canonical ADB availability and recoverability are separate signals.

- `device.adb` remains authoritative for current Android control and is healthy only when `127.0.0.1:5556` answers as the expected S24.
- `device.adb.recovery_readiness` describes whether Android Wireless Debugging can currently rebuild the canonical route after a future loss.

A stale or offline historical dynamic endpoint never makes canonical ADB unhealthy.

## Runtime flow

`adb-recovery-watchdog.sh` keeps its existing recovery loop. While canonical ADB is healthy it additionally calls `adb-recovery-readiness.py`.

The probe checks:
1. canonical ADB and the expected Android serial;
2. `adb_wifi_enabled`;
3. `_adb-tls-connect._tcp.local` discovery;
4. the discovered endpoint with `adb get-state`;
5. the Android serial through that endpoint.

A verified endpoint is stored as `~/.openclaw/watchdogs/adb-last-endpoint`. The probe writes only technical state to `~/.openclaw/health/adb-recovery-readiness.json`; it stores no business data or credentials.

## States and notification

- `ready`: a trusted Wireless Debugging endpoint is discoverable and verified;
- `degraded`: Wireless Debugging is explicitly disabled, or enabled but no trusted endpoint is discoverable;
- `unverified`: canonical ADB is unavailable or the Wireless Debugging state cannot be observed.
Three consecutive degraded probes are required before the watchdog queues one actionable owner notification. Recovery to `ready` queues one confirmation and clears the dedup marker. Unverified probes do not request physical intervention.

The existing ADB incident path remains fail-closed for `HUMAN_REQUIRED` when canonical ADB is already lost.

## Health semantics

`health-verdict.py` publishes `device.adb.recovery_readiness` separately from `device.adb`. The readiness dimension is non-critical for immediate control, but a degraded/stale/unverified readiness state degrades the global immune verdict because resilience is reduced.

## Validation

Deterministic coverage includes canonical-down, Wireless Debugging disabled, verified dynamic endpoint, missing dynamic endpoint, stale receipt, three-failure notification deduplication, and recovery confirmation.

Live acceptance requires:
- canonical ADB identity verified;
- Wireless Debugging enabled;
- a dynamic endpoint discovered and serial-verified;
- controlled OFF/ON validation that preserves canonical ADB and restores the original Wireless Debugging state.

## Rollback

Revert the readiness commit and restore the prior `adb-recovery-watchdog.sh` and `health-verdict.py`. Removing `adb-recovery-readiness.py` is safe after the watchdog no longer references it. The feature creates only technical health/state files under `~/.openclaw`; no Android account or business data is changed.
