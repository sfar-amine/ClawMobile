# Payment Local Owner Start V1.1 — Companion Runtime

Topnet real-payment creation is moved behind Samantha local owner confirmation.

Before the owner biometric, the conversational channel can only prepare an inert `owner.confirmation` from a fresh provider quote. It cannot create the live `PaymentRecord` or call the financial adapter.

After approval, trusted local `local-start` rebuilds the exact intent with the stored requester origin, consumes the proof, creates a full validateStored-compatible live record, persists `executorAttempts=1`, and only then invokes `executeLocal`.

The record stores `authorizationSource=local_owner_confirmation`. `availableForRecord` therefore keeps the same local contract through `requires_bank_action`, `bank-return` and read-only `resume` even while external Topnet execution remains disabled.

The local record has its own 120-second payment lifetime. The owner confirmation also retains its existing 120-second lifetime, including the approved-but-not-consumed state, so Android must call local-start immediately after biometric success.

No new store, daemon, scheduler or payment engine is introduced. Existing `runs.json`, Payment Core, Topnet adapter and bank continuation remain authoritative.

Validation on canonical runtime base `683e86f`:
- TypeScript build: PASS.
- local intent builder/reference tests: 3/3 PASS.
- Payment Core: 50/50 PASS.
- Topnet adapter: 6/6 PASS.
- payment API/registry: PASS.
- capability bridge: PASS.

No real financial transaction was executed during this engineering validation. External live payment creation remains disabled and a separate positive owner-initiated Topnet acceptance is still required before promotion.
