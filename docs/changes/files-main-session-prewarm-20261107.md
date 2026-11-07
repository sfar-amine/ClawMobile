# Session file reads: the main session is confirmed at startup (07/11/2026)

## Problem

On 07/11 at 19:14, release `888daa93` was rolled back by the deploy acceptance. The same thing happened on 07/11 at 14:05 and on 05/11 at 23:02.

- `/files?scope=session` answered 200 within budget, but was still `deferred` after the settle window and after its late re-judgment.
- The session listing makes two CLI Gateway calls one after the other: confirming the main session (`sessions.list`), then listing its files.
- On the S24 at rest, these calls took 6.5 s and 3.5 s, under a single 13.5 s read deadline.
- Right after a restart, with every acceptance read running at once, the two calls no longer fit within that deadline.

## Change

`startCompanionServer` calls `prewarmFileMainSession()` one second after startup.

- It confirms the main session through the existing lookup and keeps the row in its existing 10-minute cache.
- The first session file read then needs only the file list.

Unchanged rules:
- Only a found main session is kept. A Gateway that does not answer at startup, or an answer without the main session, is not remembered: the next read asks again.
- No files RPC is ever sent without the confirmed main session (R20 rule, test-files-http).
- Deadlines, budgets and the acceptance are not modified.

## Evidence

- Real capture: `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-07-files-session-deferred/`.
- Test: `scripts/test-files-main-session-prewarm.cjs`, using the captured durations scaled 1/10. A cold read takes 1005 ms (two calls); the first read after the prewarm takes 354 ms (one call).

## Rollback

Revert this commit and redeploy the previous Companion.
