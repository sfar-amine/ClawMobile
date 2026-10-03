# Restore the existing runtime engineering bridge

## Verified defect
The active immutable release `20261003-memory-scale-fde743b` contains the legacy incident worker, without engineering-repair.sh or engineering-incident-result.py. It rejects catalog components as no managed handler. The working implementation survives in private engineering-sol-luna deployment evidence and the playbooks supervision overlay; importing that overlay wholesale would remove current runtime handlers.

## Scope
Restore only the existing profile dispatch, bounded controller heartbeat, waiting_model lifecycle and helpers into the current runtime source. Preserve remote_desktop handling, configured runtime root, human boundaries, Learning Gate and continuation calls. No separate worker, scheduler, store, provider or model policy.

Packaging rejects a production incident-worker source missing its engineering dispatch/helpers/lifecycle. New manifests attest this guard; historic releases remain eligible for rollback. This prevents an unrelated release from silently dropping the repair route again.

## Validation
Original incident orchestrator 6 tests and Tier-0 5 tests pass. Three isolated bridge tests verify complete worker routing through a controlled controller result, bounded waiting/retry lifecycle and rejection of an incomplete package. No real model request, service failure injection, user message or repair replay is part of these tests. The global model behavior gate was read live and valid; no emergency stop active.

## Deployment and rollback
Publish this source only to the existing private Samantha Core runtime branch, preserve Companion and concurrent source. Build a new immutable release through Tier-0 and activate only after context flush and checking no incident is active. Verify healthy supervisor processes, runtime helpers/profile support, source hashes and native maintenance adoption. Preserve the prior release as last-known-good; rollback via existing Tier-0 if verification fails. Publication, deployment and model-created repair remain distinct proofs.
