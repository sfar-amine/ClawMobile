# RDC / ADB Termux environment hardening — 2026-10-05

## Incident

A final payment-runtime verification caught an infrastructure-only failure: when the ADB server was absent, an RDC shell inherited no Termux temporary-directory variables. The ADB client attempted to start its server using a global `/tmp` path and failed before device discovery. This was independent of the payment UI and business flow.

## Correction

`remote-desktop-control.py` now creates the existing private S24 cache `~/.cache/tmp`, passes the temporary variables to the Remote process, and sets its inherited `SHELL` to the bundled `remote-desktop-bash` boundary. The MCP SDK intentionally filters most environment variables before spawning the local Desktop Commander server but preserves `SHELL`; the wrapper therefore restores only `PREFIX`, `TMPDIR`, `TMP`, and `TEMP` before delegating to the real Termux bash. No shell rc file, user payment flow, Android activity, router, daemon, scheduler, store or authorization boundary is changed.

The payment/confirmation Python clients also keep their scoped ADB environment guard, so both the transport owner and the caller fail closed independently.

## Verification

- `test-remote-desktop-shell.py`: 1/1 pass against a filtered environment and `bash -l -c`.
- `test-remote-desktop-watchdog.py`: 16/16 pass, including the wrapper `SHELL` inheritance assertion.
- `test-remote-desktop-health.mjs`: 9 remote/local health assertions pass.
- `test-tier0-control.py`: 13/13 pass.
- Live activation acceptance must verify the promoted RDC process environment, external RDC ping, canonical ADB selection and a read-only payment capability canary.

## Rollback

Revert the source commit and promote the previous immutable Tier-0 last-known-good release.

## First candidate and rollback

The first immutable candidate set the temporary variables only on the Remote parent. Live E2E proved that the MCP SDK filtered them before the local Desktop Commander child, so a real `start_process` still saw empty temporary variables. Tier-0 rollback restored the previous LKG before the candidate could become stable. The final candidate must prove the child command environment directly. Canonical RDC health also treats a process whose inherited `SHELL` does not match the wrapper from the active immutable release as `runtime_environment_stale`, forcing bounded replacement instead of preserving a semantically stale but otherwise reachable process.
