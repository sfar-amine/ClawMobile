# Payment compact UI projection — 2026-10-05

## Why
The live Topnet acceptance produced a confirmed PaymentRecord but Android did not show the terminal summary. The authoritative status had grown beyond the Android 16 KiB response guard because the full forensic timeline was returned by action endpoints.

## Change
Android-facing action/status responses now use a compact payment projection containing only request id, adapter, state, reason, quote, financial-attempt flag, receipt when terminal, and the latest deterministic UI progress stage. Full timeline, HTTP envelopes and metrics remain available only through the canonical payment status/trace-report path.

Affected UI-facing operations: local-intent status, local-start, bank-return, bank resume and bank-ui-event acknowledgements. The financial engine, one-FORM1 guard, PaymentRecord persistence and callback/readback semantics are unchanged.

The compact projection selects only meaningful progress stages and ignores noisy HTTP exchanges. This lets Android update the popup while local-start is still running without moving model reasoning into the payment path.
