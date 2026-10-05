# Termux temporary-path hardening — 2026-10-05

## Finding

Live S24 verification confirmed that Android's top-level `/tmp` is not writable by the Termux application UID. The active Claw runtime is currently healthy because its long-running processes inherit a private `TMPDIR`, but several source fallbacks could still select `/tmp` if `TMPDIR` or `PREFIX` were absent.

The installed OpenClaw package also contained escaped shell snippets in the Crabbox wrapper such as an explicit `/tmp` fallback and `${TMPDIR:-/tmp}`. The existing compatibility patcher handled ordinary quoted paths but did not match these escaped JavaScript string forms.

## Correction

- Termux-side fallbacks now resolve in this order: existing `TMPDIR`, `$PREFIX/tmp`, then `/data/data/com.termux/files/usr/tmp`.
- `bootstrap.sh`, `clawmobile` and `lib.sh` no longer fall back to Android's top-level `/tmp`.
- The OpenClaw compatibility patcher now supplies a canonical `PREFIX` when run standalone and rewrites escaped quoted `/tmp` shell snippets plus `${TMPDIR:-/tmp}`.
- The runtime-protocol example uses a Termux-writable temporary path.
- `/data/local/tmp` is deliberately unchanged because those paths are written through `adb shell`, under the Android shell domain rather than the Termux application UID.
- No Android filesystem permission is widened.

## Verification

The isolated candidate passed:

- shell syntax validation for every modified executable shell file;
- `test-termux-tmp-paths.sh`, including a synthetic Crabbox regression fixture;
- `test-openclaw-login-shell.sh`;
- `test-openclaw-archive-copy.sh`;
- `test-plugin-install-noninteractive.sh`;
- `test-tier0-control.py` — 13/13.

A source scan found no remaining `${TMPDIR:-/tmp}` or `${PREFIX:-/tmp}` fallback in the relevant production Termux scripts. Intentional test strings and compatibility-patcher match patterns remain as regression fixtures only.

## Architecture and capability impact

No capability, route, authorization boundary, scheduler, daemon, registry or source of truth changes. This is a compatibity hardening of the existing ClawMobile Termux/OpenClaw owner.

## Live acceptance

- Source commit `9091cbb39fabba3ba1e5d7b1d4765a2bb515be99` was published to the private runtime branch and verified remotely.
- Installed OpenClaw Crabbox was patched once from SHA-256 `c57ec8f9f32fb85ee7718e064f1ec2388f375747b9b3072ba9200620cf1fe47c` to `feb0a3012234f8829ff7400f09f861fd1ea5f60efafff349fe9c1ca7ec41181c`; the dangerous exact and parameter fallbacks are absent.
- Immutable Tier-0 release `20261005T133850-d3beb769` embeds the source commit, completed its 300-second soak with 0 bad samples, and is both Current and Last Known Good.
- ADB is `device`, Remote Desktop responds to a live ping, Companion answers its local HTTP probe, and the critical supervisors run from the new release.
- Long-running Claw processes retain `TMPDIR=$HOME/.cache/tmp`; Android `/tmp` remains non-writable by the Termux UID as intended.
- The regression test and login-shell test both pass from the deployed immutable release.

## Rollback

Revert the source commit. If the compatibility patch has already changed the installed OpenClaw package, restore the prior known-good OpenClaw runtime or promote the previous immutable Tier-0 Last Known Good release.
