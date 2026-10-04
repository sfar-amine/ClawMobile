# Local-owner quote timeout repair — 2026-10-04

The local-owner payment path now gives Topnet revalidation up to 20 seconds instead of the previous 10-second core bound. This remains bounded and fail-closed: no PaymentRecord or financial dispatch is created when revalidation does not complete. The change addresses two real preparation/revalidation timeouts observed before any FORM1.
