# Android runtime maintenance green — archive publish and ADB readiness — 2026-10-05

## Incident

Two Android-specific runtime behaviors kept canonical health noisy after the primary RDC incident was closed.

1. OpenClaw transcript archive publication uses `fs.linkSync(tempPath, archivePath)`. On the S24 app-private Termux filesystem, a live canary proved hard-link creation returns `EACCES`, while `fs.copyFileSync(..., COPYFILE_EXCL)` succeeds in the same directory.
2. `device.adb.recovery_readiness` is explicitly non-critical and is evaluated while canonical ADB is already healthy. Android currently refuses to persist `settings put global adb_wifi_enabled 1` (write is immediately read back as `0`). The watchdog nevertheless escalated this proactive standby condition to a canonical `human_required` incident after three checks, making a non-critical future-recovery advisory look like a current system incident.

## Correction

### OpenClaw archive publication compatibility

The existing `openclaw-compat/patch-openclaw-paths.sh` now patches the single known archive publication anchor in the installed OpenClaw distribution:

- keep the exact canonical temp file and final path;
- replace the unsupported hard-link with `COPYFILE_EXCL`;
- fsync the published file;
- preserve OpenClaw's existing EEXIST handling, parent-directory sync and SHA-256 verification.

The patch is idempotent and fails closed if the known anchor shape is not present.

### ADB recovery-readiness advisory

The existing ADB watchdog still:
- verifies canonical ADB identity;
- attempts the existing automatic Wi-Fi/Wireless Debugging repair;
- records degraded readiness and the reason;
- recovers historical readiness incidents when a trusted endpoint later becomes verified.

For proactive reasons emitted while canonical ADB is healthy (`wireless_debugging_disabled`, `wireless_endpoint_not_discoverable`, `wifi_disabled_recovery_standby`), the watchdog now emits one non-critical advisory at the owner-action threshold instead of opening a new `human_required` incident. Actual ADB loss continues to use the existing recovery/exhaustion incident path.

## Capability impact

Existing behavior only:
- `health.transaction.runtime` — future OpenClaw archive publication can complete on Android;
- `device.adb.recovery_readiness` — proactive degraded readiness remains visible but is no longer escalated as a current blocking incident.

No new capability, daemon, scheduler, database or recovery owner.

## Architecture impact

None. OpenClaw remains the archive publisher and SQLite registry owner. The existing ADB watchdog remains the recovery-readiness owner.

## Tests

- `test-openclaw-archive-copy.sh`: synthetic OpenClaw package patch, idempotence, exclusive-copy readback and collision contract.
- `test-adb-recovery-readiness-watchdog.sh`: automatic readiness repair, non-critical advisory behavior and closure of a historical incident when readiness becomes verified.
- Existing Tier-0 / incident-runtime regressions are run at the final freeze gate.

## Live evidence before change

- hard-link canary: `EACCES`
- exclusive copy canary: `ok`
- canonical ADB: `127.0.0.1:5556 device`, expected serial verified
- `adb_wifi_enabled`: `0`; an explicit existing repair write to `1` was immediately read back as `0`
- current readiness reason: `wireless_debugging_disabled`

## Rollback

Revert this runtime commit and promote the previous immutable Tier-0 Last Known Good release. The OpenClaw distribution patch is reapplied only through the existing compatibility installer/path patcher. No Android business application code or payment journey is touched.
