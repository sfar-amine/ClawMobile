# RDC / ADB login-shell environment hardening — 2026-10-05

## Incident

A live RDC command path exposed an infrastructure defect when ADB had to start its local server. Desktop Commander launches commands through `bash -l -c`. On the S24, the ClawMobile Termux environment was present only in `~/.bashrc`, while `~/.bash_profile`, `~/.bash_login`, and `~/.profile` were absent. A Bash login shell therefore skipped the managed environment and saw empty `PREFIX`, `TMPDIR`, `TMP`, and `TEMP`.

Two RDC-specific candidates attempted to compensate by injecting parent-process variables and then by setting an RDC-specific shell wrapper. Live acceptance showed that the MCP child still launched the configured Bash login shell, so those candidates were rolled back and never became Last Known Good.

## Root cause

The durable owner of the Termux environment is the OpenClaw installer, but it configured only non-login Bash startup. The defect is therefore a login-shell bootstrap gap, not an RDC process-specific environment contract.

## Correction

- Keep the existing ClawMobile environment block in `~/.bashrc`.
- Add the canonical Termux `PREFIX` and `SHELL=$PREFIX/bin/bash` to that managed block, so a login shell cannot retain a shell path from a rolled-back release.
- Make the first existing Bash login profile, in Bash precedence order (`~/.bash_profile`, `~/.bash_login`, `~/.profile`), source `~/.bashrc`.
- If no login profile exists, create only `~/.bash_profile`.
- Preserve unrelated user profile content and keep the managed login block idempotent.
- Remove the non-activated RDC-specific wrapper/environment candidate changes.

No daemon, scheduler, database, router, payment journey, Android activity, or authorization boundary is added or changed.

## Verification

- `test-openclaw-login-shell.sh` executes a real `bash -l -c` in isolated HOME directories and verifies `PREFIX/TMPDIR/TMP/TEMP`, idempotence, and preservation of an existing `~/.profile`.
- RDC watchdog 16/16, remote/local health 9/9, RDC incident-loop 5/5, Tier-0 13/13, Claw Live 19/19, and incident runtime hardening passed.
- Live activation verified the exact pre-state, applied the managed login block, proved a real RDC `start_process` and nested `bash -l -c` see the canonical Termux environment, replaced the stale RDC parent through the existing controller, verified singleton + local MCP + remote heartbeat, and completed Tier-0 soak.

## Rollback

The verified pre-state had no `~/.bash_profile`, `~/.bash_login`, or `~/.profile`. If the generated `~/.bash_profile` still contains only the managed bootstrap block, remove it; otherwise remove only that managed block. Then revert the source commit and promote the prior immutable Tier-0 Last Known Good release.


## Live acceptance

- Runtime release source commit: `9011d1319a6dc33c3794b7c2b42d72f312ab1e89`; durable installer/profile fix published in `2a0a546`.
- Runtime release: `20261005T094153-d3beb769`; Tier-0 soak completed `stable` with 0 bad samples and the release is both current and Last Known Good.
- Core supervisor environment was normalized once after the earlier rolled-back wrapper experiment: Root Guardian, Health Manager and the RDC watchdog now inherit `SHELL=/data/data/com.termux/files/usr/bin/bash`.
- Stale RDC parent PID `13362` was stopped through the existing controller and replaced by PID `21434`.
- The replacement parent has canonical `SHELL`, `PREFIX`, `TMPDIR`, `TMP` and `TEMP`; a fresh RDC `start_process` and a nested real `bash -l -c` expose the same values.
- ADB canonical loopback is `device`, ADB recovery readiness is `READY`, RDC is singleton and healthy with local MCP + remote heartbeat, and there are zero active incidents.
- The global `control_plane.maintenance` semantic warning remains a separate scheduler/task-audit backlog and is not an RDC/ADB failure.
