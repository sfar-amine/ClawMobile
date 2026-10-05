# Payment dual entrypoints runtime — 2026-10-05

Adds payable discovery and inert local handoff to the existing private Companion payment owner. Chat notifications open the existing OwnerConfirmationActivity and contain no invoice reference or bank secret. Runtime boundary remains loopback + X-ClawMobile-Owner-Flow, browser origin denied. No live PaymentRecord exists before biometric.
