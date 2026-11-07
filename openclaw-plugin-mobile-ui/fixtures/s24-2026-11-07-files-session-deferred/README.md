# S24 07/11 — session file listing still "deferred" after a Companion restart

Captured on the S24 on 07/11/2026 after the `888daa93` release was rolled back.

- `rollbacks-and-cli-timing.json`, `rollbacks`:
  - Comes from `~/.openclaw/deploys/companion-20261107T191430.json`, `companion-20261107T140527.json` and `companion-20261105T230250.json`.
  - Only the failing acceptance rows and their release identifiers are kept.
  - In all three, `/files?scope=session` answered 200 within budget but was still `deferred` after the settle window. On 07/11 19:14 the late re-judgment (`settledLate`) also failed.
- `cliTimingAtRest`:
  - The same Gateway calls the Companion makes through the CLI, timed on the S24 at rest (load 4.8), outside any deploy.
  - Confirming the main session (`sessions.list`) took 6.5 s, and a second CLI Gateway call took 3.5 s.
  - The session listing makes these two calls one after the other, under one 13.5 s read deadline. Right after a restart, with every acceptance read running at once, the pair no longer fits.

No session content, path or identifier from the S24 is included.
