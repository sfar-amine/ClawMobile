# L0bis — prepare the existing SDK registry on the actual restart path

The isolated S24 greeting after a diagnostic --deploy-restart measured8843ms inside the existing plugin-registry loader,23ms inside factories and1ms in auth lookup. Project memory separately consumed4951ms; this change does not alter it. This measurement is a cold restart observation, not proof of repeated cache misses. No authority-bound factory is cached.

## Existing-owner correction

The private --deploy-restart CLI now invokes prepareMainToolCatalog after a successful start and TCP readiness, before returning. The existing official SDK tools.catalog main call supplies RPC readiness and fills SDK-owned registry/module caches within the unchanged20s budget. The canonical deployment parent keeps its exclusive lock. This short-lived CLI owns and closes its own transport; no Companion-shared client is closed. No new polling, retry, model turn, tool.execute, registry or cache is added.

The CLI stdout restart protocol remains {success:true|false}. A separate closed stderr result records component runtime-preparation, service_state started and ready/unverified. An unavailable preparation is explicit; it neither claims catalogue readiness nor stops/restarts/rolls back an already started Gateway. The runtime-sync shell warm is kept only for its existing HTTP fallback path, avoiding two warms for the inherited-EX CLI path. The CLI's single catalogue attempt absorbs the existing handshake readiness gap without another readiness probe or retry.

## Verification and limits

The existing CI-registered metadata tests preserve request/closed output/budget/failure contracts. The real Linux inherited-flock restart test now injects only an inert catalogue adapter into the short-lived CLI and requires exactly one tools.catalog main call followed by one close. Actual lock inheritance, stop/start and TCP fixture remain exercised; missing deploy authority must not prepare. Existing runtime-sync tests retain HTTP fallback ordering and one-warm/no-retry contracts.

Fixture openclaw-plugin-mobile-ui/fixtures/s24-2026-10-26-registry-startup/native-timings.json contains the closed native19boundaries, provenance and exact source hash. It is not a post-change gain. Targeted source77e081cd checks passed (real tsc, lock/TCP restart, six metadata contracts, three runtime-sync cases, three CI-registration guards; log l0bis-warm77-container-v1.log). Canonical full CI of the integrated head, publication, activation and isolated final S24 acceptance are pending. No new capability/public route/configuration/MCP contract: NO_CAPABILITY. Payments unchanged.

## Rollback

Return Companion to the prior paired source through companion-deploy.sh; the existing runtime-sync fallback action remains on the prior source. This change modifies no SDK module, configuration or business data. Preserve acceptance markers and never replay an uncertain effect.
