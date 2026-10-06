# ADB post-reboot recovery auto-arm — 2026-10-06

## Problem

A physical S24 reboot on 2026-10-06 left canonical `127.0.0.1:5556` unavailable while Wireless Debugging was not armed. The existing watchdog could recover from an in-session transport loss when a trusted dynamic endpoint existed, but it could not create that future recovery path after it had already disappeared.

## Change

While canonical ADB is healthy, `adb-recovery-watchdog.sh` now proactively re-enables Android Wireless Debugging when the readiness probe reports it disabled. The action uses the already-authorized canonical ADB path, immediately re-probes identity, and accepts success only when the dynamic endpoint is serial-verified. A 15-minute cooldown bounds only failed or not-yet-verifiable retries; a verified arm clears the cooldown so a later real disable is re-armed on the next watchdog cycle.

No daemon, scheduler, registry, memory store or alternate ADB truth was added. `127.0.0.1:5556` remains canonical.

## Security and rollback

This intentionally keeps Wireless Debugging armed to make post-reboot recovery possible. Android paired-device trust remains the authorization boundary; the watchdog never accepts an endpoint without the expected S24 serial. Reverting this change restores advisory-standby behavior.

## Verification

- deterministic watchdog coverage for successful auto-arm and cooldown;
- existing readiness and recovery tests remain mandatory;
- live acceptance requires canonical ADB healthy and `device.adb.recovery_readiness=ready` after the bounded arm;
- the next real physical reboot remains the final cold-reboot recurrence proof; this change does not fabricate that evidence.

## MCP parity

No MCP primitive schema or business execution contract changes. `claw_context`, `claw_resolve`, `claw_execute`, `claw_exec`, `claw_status`, and `claw_artifact_read` are no-impact.
