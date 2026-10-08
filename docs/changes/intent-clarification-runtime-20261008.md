# Intent clarification runtime — 2026-10-08

The Samantha Companion Capability-First ingress now treats canonical `needs_clarification` routing as a local terminal pre-model result.

`model-fast-path.py` projects the Capability Graph clarification question as `status=clarification`, `model_bypassed=true`. The Companion reserves the normal stable clientRunId/runId, settles the run as `done` with the bounded question, and never calls the Gateway/model or any capability executor for that ambiguous turn. Exact duplicates reuse the same run through the existing submission-reconciliation contract.

The next user reply is a new normal request resolved through the same Capability Graph. No model-based intent classifier, second router, state store, scheduler or payment executor is added. Payment owner biometric, issuer authentication, idempotence and readback remain unchanged.

Acceptance covers helper classification, Companion submit reconciliation, conversation/history, durable fast path, Payment Core 58/58, MCP bridge and Continuum capability bridge. No payment or financial effect is exercised by these tests.
