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
- `degraded`: the recovery path is not ready, but canonical ADB remains authoritative. `wifi_disabled_recovery_standby`, `wireless_debugging_disabled` and `wireless_endpoint_not_discoverable` are advisory while canonical ADB is verified and therefore set `requires_owner_action=false`;
- `unverified`: canonical ADB is unavailable or the Wireless Debugging state cannot be observed.

When Wi-Fi is active and Wireless Debugging is OFF, the watchdog treats the condition as `auto_repairable=true` and re-enables `adb_wifi_enabled` through the already verified canonical ADB channel. If Wi-Fi itself is OFF, the watchdog does not force Wi-Fi back ON. Missing mDNS discovery remains advisory because Android can transiently remove the Wireless Debugging endpoint during Wi-Fi/network churn.

Readiness-only degradation never pages the owner while canonical ADB is healthy. The existing ADB incident path remains fail-closed for `HUMAN_REQUIRED` only after canonical ADB is actually lost and bounded deterministic recovery is exhausted.



## Android 16 behavior

On the S24 Android 16 build, Wireless Debugging is not a durable always-on control-plane guarantee. Android may clear `adb_wifi_enabled` after Wi-Fi disable/disconnect, access-point/BSSID change, or Wireless Debugging server loss. Claw therefore treats the local canonical `127.0.0.1:5556` route as primary and Wireless Debugging as a bootstrap/recovery path, not as a continuously mandatory health prerequisite.

## Health semantics

`health-verdict.py` publishes `device.adb.recovery_readiness` separately from `device.adb`. The readiness dimension is non-critical for immediate control. A non-critical degraded/stale/unverified readiness state remains visible as an advisory but does not, by itself, downgrade the global operational verdict. Critical capability failures, active incidents and stuck continuations still govern the global verdict.

## Validation

Deterministic coverage includes canonical-down, Wireless Debugging disabled, verified dynamic endpoint, missing dynamic endpoint, stale receipt, three-failure notification deduplication, and recovery confirmation.

Live acceptance requires:
- canonical ADB identity verified;
- Wireless Debugging enabled;
- a dynamic endpoint discovered and serial-verified;
- controlled OFF/ON validation that preserves canonical ADB and restores the original Wireless Debugging state.

## Rollback

Revert the readiness commit and restore the prior `adb-recovery-watchdog.sh` and `health-verdict.py`. Removing `adb-recovery-readiness.py` is safe after the watchdog no longer references it. The feature creates only technical health/state files under `~/.openclaw`; no Android account or business data is changed.


## Live acceptance — 2026-09-29

Production acceptance was completed on the real S24 without replaying a second intrusive OFF/ON cycle after another active Zain-learning session was found to be using ADB concurrently.

Observed lifecycle:

1. Before the incident, canonical `127.0.0.1:5556` and a trusted Wireless Debugging endpoint were both verified and readiness was `ready`.
2. Readiness then changed to `degraded` with `wireless_endpoint_not_discoverable` while canonical ADB was still available.
3. Canonical ADB later disappeared and Android reported `adbd=stopped`. Because another Zain session was concurrently manipulating ADB, this acceptance does not attribute the initial trigger to the readiness test.
4. The existing watchdog exhausted its bounded deterministic recovery budget and the canonical incident reached evidence-backed `human_required`.
5. The owner intervention notification was accepted on WhatsApp.
6. After Wireless Debugging was restored by the owner, the watchdog automatically recovered canonical ADB, discovered and verified a fresh dynamic endpoint, updated `adb-last-endpoint`, transitioned the incident to `recovered`, and sent the verified ADB recovery confirmation through WhatsApp.
7. Final state: `device.adb=healthy`, `device.adb.recovery_readiness=ready`, network safety healthy, 18 healthy/ready capabilities, zero degraded/down capabilities, and zero active incidents.

The three-consecutive-degraded hysteresis, proactive readiness notification deduplication and readiness-specific recovery confirmation are covered deterministically by `test-adb-recovery-readiness-watchdog.sh`. The real incident transitioned to full ADB loss before the readiness-only threshold was reached, so the live notification path exercised was the existing evidence-backed ADB `human_required` route rather than the readiness-only warning.

This acceptance validates the readiness signal, fail-closed escalation and automatic recovery lifecycle under a real incident. It deliberately does not claim causal attribution for the original ADB loss while concurrent Zain work was active.
