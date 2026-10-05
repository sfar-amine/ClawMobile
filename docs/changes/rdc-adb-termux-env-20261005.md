# RDC / ADB Termux environment hardening — 2026-10-05

## Incident

A final payment-runtime verification caught an infrastructure-only failure: when the ADB server was absent, an RDC shell inherited no Termux temporary-directory variables. The ADB client attempted to start its server using a global `/tmp` path and failed before device discovery. This was independent of the payment UI and business flow.

## Correction

`remote-desktop-control.py` now creates the existing private S24 cache `~/.cache/tmp` and passes only `TMPDIR`, `TMP`, and `TEMP` to the managed Desktop Commander Remote process. Every command spawned through RDC therefore inherits a writable Termux temporary directory. No shell rc file, user payment flow, Android activity, router, daemon, scheduler, store or authorization boundary is changed.

The payment/confirmation Python clients also keep their scoped ADB environment guard, so both the transport owner and the caller fail closed independently.

## Verification

- `test-remote-desktop-watchdog.py`: 16/16 pass, including explicit environment inheritance assertions.
- `test-remote-desktop-health.mjs`: 9 remote/local health assertions pass.
- `test-tier0-control.py`: 13/13 pass.
- Live activation acceptance must verify the promoted RDC process environment, external RDC ping, canonical ADB selection and a read-only payment capability canary.

## Rollback

Revert the source commit and promote the previous immutable Tier-0 last-known-good release.
