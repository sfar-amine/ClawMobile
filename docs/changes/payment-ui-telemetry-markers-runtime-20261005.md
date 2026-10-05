# Payment UI telemetry markers — 2026-10-05

The canonical PaymentRecord timeline now accepts an optional Android observation timestamp `clientAt` only on `bank_ui_lifecycle` events. The server still records its authoritative receipt time as `at`. A bounded ± timing guard rejects impossible/stale client timestamps.

This supports three non-sensitive Android markers: `preparing_loading_visible`, `bank_form_visible`, and `finalizing_loading_visible`. No OTP, form value, URL query, token, cookie, card data or challenge payload is added. The markers are diagnostic only and cannot mutate, resume or retry a payment.
