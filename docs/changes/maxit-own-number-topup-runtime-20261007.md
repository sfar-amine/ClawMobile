# Maxit own-number top-up runtime — 2026-10-07

Adds the staged `maxit.topup` provider to the existing private Companion payment runtime. It reuses Payment Core, PaymentRecord, OwnerConfirmationActivity, BankChallengeActivity and the existing ClicToPay bank rail.

The adapter is fail-closed at runtime initialization. It becomes `localOwnerValidated` only when the private acceptance gate file contains exactly `maxit-topup-v1-live-acceptance`. The gate is intentionally absent in the engineering deployment; therefore no real Maxit order can be dispatched before the dedicated owner acceptance.

The provider payload is Maxit-specific: runtime sends the opaque Maxit top-up reference and amount to the Maxit runner, never Topnet `invoice_id` fields. A timeout uses the adapter's Maxit transaction observer instead of the invoice-specific “same quote means unpaid” inference. Topnet behavior remains unchanged.

Build passed. Synthetic runtime acceptance: Maxit adapter 3/3, Payment Core 58/58, generic ClicToPay adapter 2/2. Full financial acceptance remains separate.
