# RDC and engineering continuity — 2026-10-03

## Verified failure chain

The running release and checked-in source both used `functional(){ alive; }`. The health verdict also used process presence. At 18:24:25 and 18:24:33 two restart attempts launched without cleanup between them; both RDC remote processes remained active (6548 and 7063). The initial outage trigger remains unproven.

The 09:38 incident reached OpenAI GPT-5.6 Sol, but its evidence had an empty `recent_health_events` list. The watchdog closed it from process presence before diagnosis returned. The additional diagnostics were not fed into subsequent model context. The wrapper's one-call governor cap prevented both a diagnostic follow-up and the availability fallback. The earlier 1 October collect-more transition also did not complete; today's source permits planning → diagnosing, so that historical transition failure is not attributed to today's state table.

An additional live-environment reproduction found the incident worker resolves `/bin/timeout`, whose Toybox implementation rejects `--kill-after=10` with exit 125. Thus the code repair controller never launches on that path. The worker translated this into `interrupted` / `waiting_model`, masking a launcher defect as provider availability.

## Changes

- Retain the existing watchdog entrypoint. Share exact process identification, serialized bounded repair and functional health through `remote-desktop-control.py`; this is a helper, not another daemon.
- Every attempt stops only RDC Remote and its direct MCP child, verifies their exact process identities disappeared, then launches once from stable HOME. User shell/build descendants are not targeted. One repair lock is shared with managed recovery.
- Readiness has a 60-second deadline, two attempts maximum, cleanup on every failed attempt, and circuit-open reconciliation without restart replay. Transient functional failures get a bounded observation window; duplicates and missing processes are immediate failures.
- An observation-only Node preload samples the existing RemoteChannel heartbeat/presence and an actual bounded local MCP ping. Receipts contain PID, process start ticks, boot ID and freshness; no credentials or new socket/server. Unsupported upstream internals fail closed. This proves local MCP plus remote transport, not the complete ChatGPT tool plane.
- The global verdict consumes the same evidence and never equates process presence with health.
- The existing shadow diagnosis receives live functional evidence, watchdog history, incident identity and prior diagnostic rounds. Round dossiers/results are retained privately. RDC allows two model calls in total, within the existing policy's maximum of four: one follow-up or availability fallback. Other component limits are unchanged.
- The worker rechecks canonical state after model completion; late or unverified output cannot trigger repair. Managed repair uses the same serialized primitive. An interrupted managed effect is independently checked and never replayed automatically.
- Use portable `timeout -k 10 420`. Launcher failures and invalid controller output fail explicitly; only an actual timeout/interruption enters its existing bounded retry state.
- Map remote_desktop learning to device.remote_desktop. Packaging refuses a watchdog missing its functional helper/preload.

## Boundaries

OpenAI provides a catalog recommendation; it does not receive unrestricted shell execution or permission to edit Tier0, tests, budgets, or watchdog code. The existing component-specific RDC handler is the only managed runtime action executed here. The global `runtime.managed_repair` catalog remains candidate-only; no generic auto-apply permission is enabled.

No scheduler, database, service, parallel orchestrator, or provider-specific memory was introduced. Existing canonical incidents, model governor, continuation and private delivery paths remain authoritative. Native confirmation, Android Control, Gateway configuration and credentials are outside this patch.

## Validation and rollback

Targeted execution covers duplicate instances, stale/mismatched receipts, dead local MCP, stale cloud heartbeat, bounded cleanup, lock contention and no replay of verified recovery. The real incident worker is exercised in an isolated HOME for collect-more → second round → one repair → independent verification, late results, unverified provider output, interrupted effects and launcher failures.

Controlled real-provider acceptance: rdc-loop-acceptance-20261003, two verified OpenAI GPT-5.6 Sol calls. First requested diagnostics; second consumed fresh evidence and identified duplicate instances, recommending the existing managed repair. No production action was executed by these acceptance calls. Actual activation and external transport checks are recorded separately.

Rollback: promote the previous verified immutable release and retain incident/provider receipts. Revert the scoped source commit only after checking concurrent changes. Source publication, activation, and live acceptance are separate states.

## Activation finding: supervisor lock portability

First activation was correctly rolled back by Tier0: three supervisor replacements each waited 20 seconds because Toybox flock rejects the file-plus-command form. RDC started only after startup grace elapsed. The fixed Health Manager uses file-descriptor flock, like the existing Tier0 bootstrap, and keeps its heartbeat fresh while waiting. A real-lock test covers an available lock and an actual held lock under the S24 PATH. Slack remained reachable and provided canonical receipts during the RDC reconnection; no mutation was replayed between transports.

Second activation found an introduced Node-wrapper incompatibility: separated --import and its value are split into NODE_OPTIONS by the installed wrapper. Tier0 again refused unhealthy RDC and rolled back. The launcher now uses --import=path; the exact wrapper preload smoke passed, and an argument-shape regression was added. Existing incident notification entrypoints are retained.
