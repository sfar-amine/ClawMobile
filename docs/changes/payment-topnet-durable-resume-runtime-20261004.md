# Topnet durable bank resume — Runtime

`Payment Core` still permits at most one financial dispatch. For live payments it now generates a one-shot bank-return token before dispatch, persists only its SHA-256 hash, and never exposes it through the public payment view.

When the adapter returns `requires_bank_action`, only the non-sensitive `checkoutId` and `gatewayOrderId` continuation is persisted. The exact bank return can call the local `bank-return` endpoint with the token. The token is consumed before a single `resume`; `resume` is adapter read-only and cannot access the card/CVC path or re-arm the Topnet acceptance gate. A repeated or wrong token fails closed.

The legacy second-confirmation route remains available for compatibility, but the Topnet Android flow no longer uses it. The issuer-owned OTP/3DS interaction remains human and outside Companion. Topnet live stays disabled by default pending a new controlled positive acceptance.
