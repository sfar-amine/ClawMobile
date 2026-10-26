# ADB readiness arms only what can be armed — 26 October 2026

On 26/10 Wi-Fi was off on the S24, so ADB recovery readiness reported `standby` / `wifi_disabled_recovery_standby`. The primary ADB was healthy. `readiness_arm_primary` asked the immune gate before the effect refused that reason. Each attempt spent model calls and opened an incident (a3e972e2, bab3ce34), which was escalated to the owner and could not be closed by any repair.

- New `readiness_armable`: it holds the existing check (Wireless Debugging disabled), used by both the caller and the effect. With Wi-Fi off, the watchdog stays in standby with no model call and no incident.
- The arm itself, its cooldown and its verification are unchanged.

Tests: new cases in `test-adb-recovery-readiness-watchdog.sh` with the S24 readiness row. They fail without the fix. The new assertions are explicit, because `! grep` does not fail under `set -e`. Rollback: revert this commit.
