# Payment passive notification runtime — 2026-10-05

The private Companion notification for a Chat-originated payment handoff is now display-only. It carries only the provider and formatted amount. It contains no notification action, tap instruction, invoice reference, confirmation UUID or banking secret.

The Chat client is responsible for separately opening the already-existing OwnerConfirmationActivity after the inert handoff returns. This change does not create a PaymentRecord, send FORM1, alter ClicToPay execution, automate OTP/SMS or change BankChallengeActivity.

Validation: TypeScript build passed; payment-handoff 2/2, payment-core 57/57, Topnet adapter 9/9 and generic ClicToPay provider 2/2 passed (70 tests total). The payment API/registry guard also passed.

Architecture impact: none. The existing private Companion, Payment Core and Android confirmation surface remain the only owners. Rollback is a scoped revert of the notification arguments.
