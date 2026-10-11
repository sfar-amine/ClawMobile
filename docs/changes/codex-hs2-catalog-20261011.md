# HS2 catalogue preparation

Read-only GET /v1/catalog serves bounded canonical HS1 presentation through the existing Control pool. Conditional ETags, FR/EN and guarded native HTTP access are implemented and locally tested. Ten concurrent cold reads share one owner read; initial cold HTTP response is explicitly unavailable/deferred after at most 200 ms; only the later owner result provides catalogue entries. Initial test measured cold208 ms and warm p95 77.69 ms locally; production qualification is absent.

Blocked: Git-generated samples are not S24 captures. Positive Graph/health/gate evidence and receipt/cache badges remain missing. All actions remain unavailable, voiceMemo=false, badges empty. No supplier/network guard/payment/app effect. Requires playbooks PR69 and Claude qualification; no claim of deployed availability.

Resume hardening: bounded integer orders and ISO dates, unique hierarchy/slots/pins, unknown owner/gates/account fields stripped and requested locale binding. HTTP test also waits for the actual 15 s Control TTL, then proves ten callers trigger one new source read without returning stale catalogue/ETag. Latest local cold205.02ms, settle2102.31ms, warmp95=78.97ms; source error503. Physical proof, badges and readiness remain blocked.
