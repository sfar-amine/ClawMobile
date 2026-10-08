# Samantha submit reconciliation runtime — 2026-10-08

## Incident

A Samantha Android submission entered `Uncertain` while the screen still displayed a completed historical Gemini refusal. The current `clientRunId` had no corresponding Companion run. At submission time the OpenClaw Gateway was unavailable and later recovered.

## Root cause

`POST /v1/runs` checked Gateway health before recording the client identity, the existing run registry did not persist/deduplicate `clientRunId`, and no by-client status read existed. Android therefore could not distinguish a definite pre-dispatch rejection from a lost acknowledgement. This was a generic transport gap before Capability-First, not a Maxit/Topnet rule. Live Android acceptance then exposed a second ingress gap: Companion submits directly through the Gateway `agent` method, so the channel-level `inbound_claim` hook was not the authoritative pre-model boundary for these local app turns.

## Fix

- Reserve `clientRunId` atomically in the existing Companion runs registry before agent dispatch.
- Bind the reservation to the normalized session and material request identity.
- Return the same run for sequential or concurrent duplicates; reject identity reuse with a different request.
- Expose `GET /v1/runs/by-client/{clientRunId}` for status-before-retry reconciliation.
- Return a structured `accepted=false / submissionState=not_submitted / retrySafe=true` response only when no reservation/dispatch occurred.
- Preserve `clientRunId` in run status and persistence.
- Resolve local owner requests through the existing `model-fast-path.py --check` contract inside Companion before Gateway/model submission.
- Reserve the client identity before executing an eligible Known capability; settle the same local run from the canonical capability result. `miss`/`assist` alone continue to the model. A Capability-First infrastructure error or Known state change does not fall through to a provider-generated refusal.

No router, database, scheduler or retry engine is added. This protocol is capability/provider-neutral and therefore covers Maxit, Topnet and future validated STEG/SONEDE/app/web adapters. The existing channel hook remains useful for channel ingress; Companion now applies the same canonical contract at its own real local ingress instead of depending on that hook being invoked by the Gateway.

## Effect integrity

The change deduplicates request admission only. It does not retry an accepted business action, payment dispatch, FORM1, bank continuation or provider mutation. Capability execution, owner biometric, issuer verification, PaymentRecord idempotence and provider readback remain unchanged.

## Result provenance

A run now persists its execution provenance (`gateway` or `capability_first`). A local Capability-First result is authoritative in the Companion registry and is never enriched from the shared OpenClaw session transcript or trajectory. This prevents an older Gemini answer with the same visible request from overwriting a newer deterministic result. Gateway/model runs keep the existing transcript/trajectory enrichment path. In-progress local capability runs are also excluded from transcript backfill.

## Deployment and live acceptance

The runtime is active on `runtime/samantha-companion-private` commit `4da5697cdb7a033b270d42bd1fee1c874fcaaee7`. A live local Companion submission with stable client identity `samantha-live-closure-06efcf11b23f` completed through `executionSource=capability_first`; by-client reconciliation returned the same run, an exact duplicate returned that same run without re-execution, request-identity reuse with different material was rejected with HTTP 409, and no model transcript row was created for the client identity.

A separate definite pre-dispatch rejection returned `accepted=false`, `submissionState=not_submitted`, `retrySafe=true` and left by-client status unknown, proving the Android client can distinguish safe retry from uncertain accepted work. No payment handoff or financial effect was executed during this acceptance.
