# The deploy waits for a Gateway-backed read — 26 October 2026

On 26/10 at 11:33, on the S24, `/v1/control/health` already answered 200 while the Gateway was still starting: its log shows `startup-sidecars-pending` until 11:34:59. The routes that go through the Gateway answered 503: `/agent/config`, conversation metadata, the WhatsApp allowlist and automations. The acceptance failed and deploy 721e940e was rolled back. At 11:39, a request from Amine also failed because the Gateway was restarting again.

- `gateway_ready` now waits for both `/v1/control/health?contract=2` and `/v1/agent/config` to answer 200. `/agent/config` is a fast, read-only route that goes through the Gateway. The wait is bounded at 45 × 4 s, about 3 minutes, like the calm wait that follows. `COMPANION_DEPLOY_GATEWAY_READY_TRIES` sets the bound in tests.
- The acceptance, budgets and rollback are unchanged.

Test: the real `gateway_ready` runs with a fake `curl` that gives the S24 answers (control 200, agent 503, then 200). It fails without the fix. The deploy suites pass. Rollback: revert this commit.
