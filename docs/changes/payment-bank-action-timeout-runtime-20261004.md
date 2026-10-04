# Bank-action timeout — runtime — 2026-10-04

The existing Companion now owns a 60-second timeout for payments in `requires_bank_action`. Timers are reconstructed from durable `bankActionRequiredAt` records when the Companion starts; no new scheduler or daemon is introduced.

At expiry, Payment Core atomically claims the same PaymentRecord and performs read-only reconciliation. If a fresh provider quote still matches the exact unpaid invoice, the record becomes `cancelled / payment_cancelled`. If the invoice is no longer definitely unpaid, the existing read-only resume path is used once to seek correlated settlement or rejection. Insufficient evidence remains `effect_unknown`.

The timeout never creates a second financial dispatch. A concurrent exact bank return and the timeout race on the same durable record; only one can claim the transition.
