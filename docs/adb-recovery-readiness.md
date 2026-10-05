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
- `standby`: canonical ADB is healthy, but the future Wireless Debugging recovery path is not currently armed or discoverable. This is a non-critical advisory, `requires_owner_action=false`, and the readiness failure counter is reset;
- `degraded`: reserved for an actual readiness fault that is not one of the known primary-healthy standby conditions;
- `unverified`: canonical ADB is unavailable or the Wireless Debugging state cannot be observed.

While canonical ADB is healthy, `wireless_debugging_disabled`, Wi-Fi-off standby, and a missing dynamic Wireless endpoint all normalize to `standby`. The watchdog does not toggle Wireless Debugging, increment readiness failures, or open `human_required` for those states. A stale readiness-specific incident is recovered/superseded when the primary path is independently healthy.

The existing primary ADB recovery loop remains fail-closed: only after canonical ADB is actually lost and the bounded deterministic recovery attempts are exhausted can the existing ADB incident reach `HUMAN_REQUIRED`.

## Health semantics

`health-verdict.py` publishes `device.adb.recovery_readiness` separately from `device.adb`. The readiness dimension is non-critical for immediate control. `standby` is accepted as an explicit advisory state and does not, by itself, downgrade the global operational verdict. `degraded`, `stale` and `unverified` remain available for genuine readiness uncertainty/failure. Critical capability failures, active incidents and stuck continuations still govern the global verdict.

## Validation

Deterministic coverage includes canonical-down, primary-healthy Wireless Debugging standby, verified dynamic endpoint, primary-healthy missing endpoint standby, stale receipt, backward compatibility for historical degraded advisory receipts, stale readiness-incident supersession, and recovery confirmation.

Live acceptance distinguishes two valid conditions:
- **standby acceptance**: canonical ADB identity is verified, Wireless Debugging is unavailable/disabled, the receipt is `standby`, the readiness failure counter is zero, and no readiness `human_required` incident is active;
- **ready acceptance**: canonical ADB identity is verified and a dynamic Wireless Debugging endpoint is discovered and serial-verified.

A destructive OFF/ON cycle is not required to prove standby semantics. Actual primary-ADB loss continues to be validated separately by the bounded recovery/exhaustion tests.

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
