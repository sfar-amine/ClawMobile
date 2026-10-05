# RDC / ADB login-shell environment hardening — 2026-10-05

## Incident

A live RDC command path exposed an infrastructure defect when ADB had to start its local server. Desktop Commander launches commands through `bash -l -c`. On the S24, the ClawMobile Termux environment was present only in `~/.bashrc`, while `~/.bash_profile`, `~/.bash_login`, and `~/.profile` were absent. A Bash login shell therefore skipped the managed environment and saw empty `PREFIX`, `TMPDIR`, `TMP`, and `TEMP`.

Two RDC-specific candidates attempted to compensate by injecting parent-process variables and then by setting an RDC-specific shell wrapper. Live acceptance showed that the MCP child still launched the configured Bash login shell, so those candidates were rolled back and never became Last Known Good.

## Root cause

The durable owner of the Termux environment is the OpenClaw installer, but it configured only non-login Bash startup. The defect is therefore a login-shell bootstrap gap, not an RDC process-specific environment contract.

## Correction

- Keep the existing ClawMobile environment block in `~/.bashrc`.
- Add the canonical Termux `PREFIX` to that managed block.
- Make the first existing Bash login profile, in Bash precedence order (`~/.bash_profile`, `~/.bash_login`, `~/.profile`), source `~/.bashrc`.
- If no login profile exists, create only `~/.bash_profile`.
- Preserve unrelated user profile content and keep the managed login block idempotent.
- Remove the non-activated RDC-specific wrapper/environment candidate changes.

No daemon, scheduler, database, router, payment journey, Android activity, or authorization boundary is added or changed.

## Verification

- `test-openclaw-login-shell.sh` executes a real `bash -l -c` in isolated HOME directories and verifies `PREFIX/TMPDIR/TMP/TEMP`, idempotence, and preservation of an existing `~/.profile`.
- Existing RDC watchdog/health, Tier-0, incident-loop, and Claw Live regressions must remain green.
- Live activation must snapshot the current profile state, apply the managed login block, verify a real RDC `start_process` sees the canonical Termux environment, restart RDC through the existing controller, verify singleton + local MCP + remote heartbeat, then complete Tier-0 soak.

## Rollback

Restore the exact pre-change login-profile snapshot, revert the source commit, and promote the prior immutable Tier-0 Last Known Good release.
