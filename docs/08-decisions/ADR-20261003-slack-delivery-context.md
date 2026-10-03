# ADR-20261003 — Durable Slack delivery and bounded context entry

Status: accepted for scoped implementation; runtime acceptance recorded separately.

## Decision

Extend the existing Slack Socket adapter with a private file journal for durable admission and response delivery. Remote Bridge remains the execution and idempotency owner. The existing health manager distinguishes delivery attention from service failure. History is observation-only: a previously unseen command is never executed from catch-up.

Use a read-only context helper in ui-playbooks to resolve relevant capability references, contract hashes and paginated context deltas. It neither migrates the context database nor advances a session cursor. Install a scoped rule block through a versioned, backed-up, compare-before-write installer. ChatGPT project settings remain outside this installer.

## Consequences

An interrupted reply can be recovered without new execution. Publication may duplicate a reply after an uncertain Slack acknowledgment. Queue bounds, explicit attention state and retained canonical receipts make uncertainty visible. This adds no daemon, scheduler, database, orchestrator or universal permission. Client latency and platform approval policy remain external constraints. Rollback restores the previous immutable runtime and the installer backups while retaining the private journal for inspection.
