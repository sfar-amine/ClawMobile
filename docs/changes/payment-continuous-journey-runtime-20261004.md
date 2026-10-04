# Continuous payment journey runtime — 2026-10-04

Companion exposes a read-only local-intent status keyed by confirmationRequestId. Before local-start it reports owner-confirmation state; afterwards it reports the canonical PaymentRecord. No mutation or replay is added.
