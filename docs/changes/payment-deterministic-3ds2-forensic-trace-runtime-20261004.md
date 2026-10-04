# Deterministic 3DS2 and forensic payment trace — 2026-10-04

The Companion now accepts the additional deterministic payment stages emitted by the billing runner and persists sanitized http_exchange envelopes in the existing PaymentRecord.trace.

Each envelope is validated fail-closed: method, origin/path, byte counts, status, duration, bounded sanitized snapshots and SHA-256 fingerprints. Snapshot structure is revalidated before persistence and secret-like or personal fields must already be explicit redaction markers. The runtime rejects malformed or unsafe evidence rather than weakening the payment state machine.

The trace capacity is raised to 160 events to cover provider login, checkout, 3DS2 preflight, gateway exchange, provider callbacks, readback and terminal classification while retaining one canonical record. No new logger service, database, scheduler or transaction engine is introduced.

One financial dispatch maximum, one read-only bank resume maximum and all existing no-replay guards remain unchanged.
