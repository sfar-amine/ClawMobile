# Recovery after an outage and a reboot — 27 October 2026

On 27/10, after a night without internet and a reboot of the S24, Samantha did not come back by itself. Amine decided that nothing restarts while offline, but that Samantha must come back on its own once the network is back.

What blocked, measured on the S24:

- The health manager refused to restart the Companion (`state=idle_unproven action=skip_repair` every 15 s). The idle proof read all 31 366 Remote Bridge receipts and exceeded its 3 s deadline (3.28 s, `remote_bridge_scan_partial`). There was no Companion process: nothing could be interrupted.
- The state files of the health manager still said `healthy` for dead services and kept a 15 min Companion backoff from the previous boot.

What changes:

1. `samantha-health-manager.sh`: the idle proof is required only to replace a live Companion. With no Companion process the existing repair (lease, deploy lock, canonical mode) runs directly.
2. `gateway-memory-guard.py`: the idle proof skips receipts written before the current boot; their owners died with it.
3. `samantha-health-manager.sh`: on a new boot (`boot_id`), each `healthy` or `degraded` service state becomes `unknown`, with its failures and backoff cleared, so it is checked again at once. On the first start of this version the boot is only recorded.

Tests: `test-health-deploy-lock.py`, `test-gateway-memory-guard.py` and the new `test-health-boot-reset.py` (registered in CI) reproduce the S24 situation and pass; the other health suites pass. Rollback: revert this commit.
