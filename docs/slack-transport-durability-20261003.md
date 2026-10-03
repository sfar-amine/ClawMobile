# Slack transport durability — 2026-10-03

The existing adapter now persists an allowlisted request before acknowledging its Socket Mode envelope. Remote Bridge remains the sole execution and request/task/step idempotency owner. The adapter owns only admission and response delivery; no daemon, scheduler, database or new permission is introduced.

## Behavior

- Private atomic journal: 128 unfinished messages; delivered payloads erased immediately, dedup metadata retained for 24 hours, capped at 1,024 rows. Corrupt durable records fail closed.
- Before retrying a submitted request, read and verify its canonical receipt. An uncertain effect never creates a new request identity. Running/received work is observed; after three minutes its true state is reported.
- HTTP headers and response bodies have deadlines: Slack/receipt reads default 10 s, Bridge submission 35 s. Environment overrides CLAW_SLACK_HTTP_TIMEOUT_MS and CLAW_SLACK_BRIDGE_TIMEOUT_MS are validated. Six attempts, bounded exponential delay and Slack Retry-After, one publication per second. A hung publication releases the queue after its deadline.
- Results persist before Slack publication and survive process restart. Publication is at least once: an uncertain Slack acknowledgment can produce a duplicate response. This is not an exactly-once Slack guarantee.
- Reconnection and periodic history checks observe missed requests using existing history access. Five-minute window, thirty-second overlap, three pages per pass, continuation cursor and 15 s processing budget. No historical command is automatically executed. Absent receipts are reported as not_received, requiring intent validation before same-ID resubmission. Older gaps and inaccessible history remain visible limitations.
- Health separates connection/service failures from delivery attention. Probe exit 3 means a fresh connected service has delivery work needing inspection; the health manager and primary repair do not restart it for that reason. Stale heartbeats/disconnection still require service recovery. Exhausted jobs remain private and visible in the bounded journal for receipt inspection, not silent replay.
- Large replies retain execution status, stdout/stderr previews and a full receipt reference; echoed shell commands are omitted from replies. Existing audit/receipt storage policies continue to apply.

## Verification and activation

Tests cover persist-before-ACK, restart inbox/outbox, duplicate event and request conflict, lost Bridge HTTP response, stalled Slack publication, history pagination without execution, payload removal, queue bounds, corrupt journal, heartbeat/repair semantics and existing Slack reconnect/429/oversized response regression.

Source publication and runtime activation are distinct. Build the candidate from the active immutable release and overlay only the changed adapter, journal, health probe, health manager, primary repair and test files. Compare manifests, test the immutable topology, check concurrent owners and current executions, then promote through tier0. Retain the preceding release for rollback and activate that preceding release when rolling back.

## Limits and measurements

No control over ChatGPT's connector implementation, model scheduling or platform confirmation policy is assumed. No new ChatGPT installation is required. Existing sender/channel allowlists and core mutation checks remain mandatory. Two earlier missing Slack inputs had no canonical receipt; their upstream root cause was not established.

The related ui-playbooks change supplies one bounded context entrypoint and routing/response instructions. This is where fewer interactions can reduce preparation time. A transport ping alone does not measure user-visible cold latency. Acceptance metrics are recorded separately after activation.
