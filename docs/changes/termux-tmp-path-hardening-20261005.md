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

## Deployment

The source candidate is publishable with deployment state `not_applied`. Runtime activation must apply the existing compatibility patch to the installed OpenClaw package and promote a fresh immutable Tier-0 release before this record can be marked runtime-verified.

## Rollback

Revert the source commit. If the compatibility patch has already changed the installed OpenClaw package, restore the prior known-good OpenClaw runtime or promote the previous immutable Tier-0 Last Known Good release.
