# Payment dual entrypoints runtime — 2026-10-05

Adds payable discovery and inert local handoff to the existing private Companion payment owner. Chat notifications open the existing OwnerConfirmationActivity and contain no invoice reference or bank secret. Runtime boundary remains loopback + X-ClawMobile-Owner-Flow, browser origin denied. No live PaymentRecord exists before biometric.

Deployment: private runtime commit `0594743` is live; compiled `payments.js` SHA-256 `8375122519876af9b73661417429345c114423351d20bb8029948ca52ff8d3bd`, Companion PID 13458, health connected. 73 payment tests plus the owner-boundary API guard passed. Automated UI acceptance remains external-tool-plane blocked and is not claimed.
