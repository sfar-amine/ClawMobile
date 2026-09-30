# Claw Live observation dedupe — 2026-09-30

Repeated read-only observations can now be compacted for 10 seconds when they are identical.

Scope is intentionally narrow:
- repeated OpenClaw read and ls tool calls are deduplicated;
- matching successful read and ls results are deduplicated;
- identical assistant INFO observations are deduplicated;
- write, edit, process and exec events remain individually visible;
- no execution, retry or mutation behavior is changed.

The existing Renderer dedupe mechanism is reused; no new daemon, scheduler or persistence layer is added.

Regression covers both observation compaction and visibility of repeated mutating tool events.
