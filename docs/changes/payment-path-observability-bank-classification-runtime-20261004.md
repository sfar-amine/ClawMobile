# Payment path observability and rejection semantics — 2026-10-04

A real Topnet local-owner attempt completed owner review/authentication and exactly one FORM1, then returned through a correlated provider failure path while the invoice stayed unpaid. No bank challenge or continuation was created.

The runtime had two observability defects:

1. The Topnet adapter relabeled any verified correlated failure plus unpaid provider read as `bank_declined`, even when the lower layer only knew `payment_rejected_reason_unavailable`.
2. The durable `PaymentRecord` retained terminal state and counters but not the sanitized intermediate path.

This change preserves the verified rejection reason and adds an optional bounded `trace` array to the existing record. Events are ordered and timestamped and may carry only a stage, controlled outcome/reason, and sanitized invoice state. The live runner's intermediate events are forwarded through the existing adapter callback and persisted by the existing single-writer registry. Bank-return/resume uses the same trace.

No raw payment credential, CVC, OTP, CReq, continuation identifier, gateway identifier, bank-return token, full URL or response payload is accepted into the timeline. Historical records remain backward compatible because `trace` is optional.

This is an observability and classification correction, not proof that the external ClicToPay rejection cause is fixed. The next explicitly owner-requested live payment can provide the first fully instrumented path.
