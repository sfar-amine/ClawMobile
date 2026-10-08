# Samantha submit reconciliation runtime — 2026-10-08

## Incident

A Samantha Android submission entered `Uncertain` while the screen still displayed a completed historical Gemini refusal. The current `clientRunId` had no corresponding Companion run. At submission time the OpenClaw Gateway was unavailable and later recovered.

## Root cause

`POST /v1/runs` checked Gateway health before recording the client identity, the existing run registry did not persist/deduplicate `clientRunId`, and no by-client status read existed. Android therefore could not distinguish a definite pre-dispatch rejection from a lost acknowledgement. This was a generic transport gap before Capability-First, not a Maxit/Topnet rule.

## Fix

- Reserve `clientRunId` atomically in the existing Companion runs registry before agent dispatch.
- Bind the reservation to the normalized session and material request identity.
- Return the same run for sequential or concurrent duplicates; reject identity reuse with a different request.
- Expose `GET /v1/runs/by-client/{clientRunId}` for status-before-retry reconciliation.
- Return a structured `accepted=false / submissionState=not_submitted / retrySafe=true` response only when no reservation/dispatch occurred.
- Preserve `clientRunId` in run status and persistence.

No router, database, scheduler or retry engine is added. This protocol is capability/provider-neutral and therefore covers Maxit, Topnet and future validated STEG/SONEDE/app/web adapters.

## Effect integrity

The change deduplicates request admission only. It does not retry an accepted business action, payment dispatch, FORM1, bank continuation or provider mutation. Capability execution, owner biometric, issuer verification, PaymentRecord idempotence and provider readback remain unchanged.
