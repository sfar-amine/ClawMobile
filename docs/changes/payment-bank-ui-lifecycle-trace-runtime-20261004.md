# Bank UI lifecycle trace runtime — 2026-10-04

The canonical PaymentRecord timeline now accepts bank_ui_lifecycle with bounded outcomes such as resumed, paused and stopped. This is diagnostic evidence only and cannot mutate, retry or resume a payment.
