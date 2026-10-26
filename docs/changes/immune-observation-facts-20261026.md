# Immune decisions get the owner's probe facts — 26 October 2026

After the deploy of 9527b700 on 26/10, `adb_watchdog` and `remote_watchdog` stayed down. The health manager asked the immune gate for `bounded-supervisor-restore`, and Sol answered "undetermined: the evidence reports a failed health check but no diagnostic details". It answered the same way 18 times out of 37 successful decisions on the S24. The cause: `immune-action.sh` never passed an observation, so the model only read the default sentence "Owner observed a failed native health check".

- `immune-action.sh`: `immune_action` forwards `IMMUNE_OBSERVATION`, when the caller sets it, as `--observation`. Without it nothing changes. New `immune_supervisor_facts` states whether the supervisor is absent or running from another release, and which script is expected.
- Health manager and root guardian: supervisor restores pass those facts. HTTP, ADB, sshd and Slack restores pass their probe result.
- ADB watchdog: ADB recovery and readiness repair/arm pass the readiness reason they already hold.

The operations, callbacks, budgets, locks and verifiers are unchanged; the model still only chooses between this bounded operation and waiting. Tests: 1 new test in `test-immune-action.py`; 23 neighbouring suites pass. Rollback: revert this commit.
