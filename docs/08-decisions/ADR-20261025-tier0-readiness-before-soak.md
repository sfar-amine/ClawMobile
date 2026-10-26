# ADR — separate native activation readiness from the Tier0 soak

Status: source prepared, runtime acceptance pending. Date:25October2026.

Promotion previously armed the soak before asynchronous bootstrap and sequential AI-approved supervisor restoration. The S24 candidate snapshot was sampled before the incident worker's start completed. A resident Python watchdog also retained code from before the AI admission change despite updated files; its newly required bridge was not part of the installed binary set. These are operational prerequisites to the voice recipe, not evidence of a worker crash.

Reuse install-tier0-control, tier0-control, health-verdict and the existing watchdog/guardian. Install the complete versioned dependency set before reloading only captured old watchdog identities. Refuse in-flight children, preserve PID reuse protection and use one Tier0 watcher flock. Do not add a competing recovery service or bypass AI admission.

The existing Tier0 state has an activation phase, a bounded native readiness observation, then its original soak phase. The readiness proof must be fresh, identify the selected immutable runtime and include every manifest critical capability. Readiness does not replace the soak: duration, startup grace, two distinct bad samples, AI-selected rollback, emergency stop and LKG retention remain. Keep deployment_guard during the wait, release control.lock so bootstrap can resolve root, then reacquire to revalidate target and evidence before arming the soak. Failure remains explicit and cannot become a green deployment.

No transcript, incident payload or secret is required for this decision. The committed real fixture contains only event times, component states, process identity and code hashes. Rollback uses the existing deployment owner, with a fresh canonical status check before any retry.
