# Continuum Lot 4 — Remote Bridge effect fence — 2026-10-07

## Scope

This change extends the existing Remote Bridge executor with an optional Claw Continuum fencing contract. It does not add a second executor, scheduler, store, router or retry engine.

For a non-read request whose taskId resolves to a Continuum journal, the Bridge requires a persisted Continuum fence before creating a new execution receipt or calling the existing dispatcher.

## Boundary

The Bridge reads the latest complete event from the existing foreground Continuum journal and checks:

- mission is running and control is active;
- current owner, boot identity and lease are still valid;
- ownershipEpoch matches;
- current Attempt is the fenced Attempt and is already submitted;
- effectKey matches;
- the persisted dispatch fence matches the wire fence;
- requestId, taskId, stepId, method and paramsHash match the persisted transport binding.

The check runs after existing requestId/taskId+stepId deduplication but before creation of a new receipt and before dispatch. Therefore a duplicate request with an existing receipt can retrieve that receipt even after ownership changes, while a stale request with no existing receipt cannot produce a new effect.

The latest journal event is authoritative for fencing. A lagging projection cannot re-authorize an older epoch.

Read-only Bridge methods remain fence-free. Legacy non-Continuum tasks remain unchanged.

## Tests

The TypeScript build passes. Existing Remote Bridge core, Slack, Slack resilience and MCP bridge suites pass.

The core suite additionally verifies:

- valid Continuum fence admits one append;
- duplicate physical request does not append twice;
- stale ownership epoch is rejected before write;
- missing fence is rejected for a Continuum mutation;
- expired lease is rejected;
- journal tail overrides a stale projection;
- read-only request remains compatible without an effect fence.

The fallback CLI accepts an optional opaque Continuum fence JSON and forwards it unchanged to the existing Bridge.

## Activation

Source activation is separate from publication. After publication, build the canonical Companion source, restart through the existing supervised path, then run a synthetic temporary-file acceptance proving response-loss recovery and stale-fence rejection. No business capability is enrolled by this change.

## Limits

- The fence applies only to requests explicitly correlated to a Continuum task.
- The Bridge reads a bounded journal (maximum 4 MiB) at effect admission. This is acceptable for the pilot; later performance work may add a tail-index optimization without changing semantics.
- A Bridge receipt proves executor admission/execution correlation, not business success. Domain verification remains mandatory.
- No payment, PULSE, Spotify, Android UI or model route is migrated in Lot 4.
