# WhatsApp: recover after a prolonged network outage

On 15 October 2026, the S24 log recorded a 428 disconnect at 00:01:30 UTC, then repeated 408 setup failures with EAI_AGAIN for web.whatsapp.com. At 00:05:25 the twelfth failure stopped the monitor with a terminal disconnect. The gateway health monitor then skipped every restart. The linked session remained stopped after DNS recovered. The cause of the initial DNS outage is not established.

The existing WhatsAppConnectionController now keeps its socket ownership and monitor loop for explicitly recoverable transport failures. The initial attempt budget is unchanged: at failure 12, instead of stopping, it enters slow recovery. Nominal delays are 60, 120 and then 300 seconds, with 20% jitter capped at 300 seconds: 48–72 s, 96–144 s, then 240–300 s. Each delay permits one socket setup, not another twelve-attempt burst. Attempts are counted with a saturation limit. Reset requires at least two minutes connected and transport activity within the last minute; flapping does not reset it.

Only 408, 428, 503, the existing watchdog timeout and explicit transport error codes enter slow recovery. Logout (401) and connection replacement (440) stop immediately. Bad session, forbidden, mismatch, unknown status and restart-required (515) keep their existing bounded behavior; unstable credential persistence does not enter infinite recovery. No credential is deleted by this patch.

The monitor publishes a bounded recoveryRetryAt in its existing status object. The existing gateway health monitor leaves that owner alone until the deadline; a stuck owner can still be recovered after expiry. Disconnected remains disconnected: no fabricated healthy or delivered status. No extra daemon, timer service, scheduler, queue or store is introduced.

## Packaging and rollout

This is a compatibility patch for the installed OpenClaw and @openclaw/whatsapp **2026.9.6** modules. Original and resulting SHA-256 values are pinned in installer/termux-lite/openclaw-compat/whatsapp-network-recovery.json. The patcher validates all modules before writing, performs atomic per-file replacements, restores preceding writes on ordinary I/O failure, and can resume an interrupted partial patch. Rollback reconstructs the exact original bytes. It never changes ephemeral plugin captures or credentials.

runtime-sync applies the patch and restarts the existing gateway owner when needed. Its read-only check reports drift. gateway-start reapplies the same hash-gated patch before a fresh gateway load. An unsupported version or ambiguous npm generation is refused for patching and reported by runtime-sync; startup remains available with an explicit warning. Upgrades require a reviewed new patch or removal after an upstream fix. No claim of universal future-version compatibility.

The Companion deployment rollback removes this patch before returning to a revision that does not own it. If source bytes cannot be verified, rollback stops with an explicit failure rather than overwriting unknown changes. The standard plugin synchronization and gateway restart then restore the previous loaded code. Manual recovery is also available with the reviewed patcher --rollback, followed by a restart through the Companion owner.

## Validation

Real installed code was captured read-only from the S24 into openclaw-plugin-mobile-ui/fixtures/s24-2026-10-16-whatsapp-recovery. It contains upstream MIT-licensed code only, no credentials, identifiers or chat messages.

Local tests on the S24, isolated from the running installation:
- 11 JavaScript behavior cases: exhaustion beyond 12, 10,000 repeated failures, jitter bounds, transport classification, auth boundaries, flapping, stable reset, status deadlines, the actual gateway supervisor, existing single-flight and cancellation; all three resulting modules parse.
- 7 patch transaction/CLI cases: apply/check/idempotence/exact rollback, changed hash, unsupported version, ambiguous package generations, interrupted partial application and injected write failure.
- 10 runtime-sync cases, including patch-only gateway restart, unsupported patch refusal and drift.
- Gateway preflight (9), WhatsApp stale locks (5), deploy lock (2), channel health and owner-send idempotency contracts; shell syntax and git diff checks.

The new tests are registered in CI. This is the complete scoped local regression suite for this change; the repository-wide plugin/Android suite was not run because no TypeScript or Android source changes.

## Boundaries and live acceptance

Deployment is **not applied**. The previously restored live channel was independently read as running=true, connected=true, healthState=healthy, lifecycle=ready, lastError=null. That is evidence of temporary service recovery, not of this candidate patch.

Merge and deployment belong to Claude under AGENTS.md and convergence document 52, unless Amine explicitly authorizes Codex for this operation. Deploy only through the existing companion-deploy owner, then verify source hashes, the newly loaded gateway generation, channel connection and a new inbound deterministic request followed by its outbound delivery evidence. A connection status alone is not end-to-end proof.

A controlled extended-outage acceptance remains to be performed after deployment, with safe fault injection and a recovery lease if a real network setting is changed. No live network outage was induced during development. The optional Android network-return acceleration is not included: no existing callback bridge into this controller was established, and adding another watcher would create a second owner. Recovery can therefore wait up to five minutes plus socket setup after network return.

Offline message ingestion, authorization, deterministic business routing, delivery queue and deduplication remain upstream behavior. This patch neither replays chat history nor guarantees recovery of every missed message. No messages were sent by the test suite.

## Engineering references

The policy follows [RFC 6455 section 7.2.3](https://www.rfc-editor.org/rfc/rfc6455#section-7.2.3) and [AWS guidance on retries and jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/). The precise timing values above are our bounded operational choice, not a prescribed standard.
