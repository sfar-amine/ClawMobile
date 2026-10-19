# F1 — Runtime roots and shared contract parity (18 October 2026)

Tier0 exports a **pinned termux-lite directory**, not a repository. Claude’s sanitized S24 observation is recorded in `openclaw-plugin-mobile-ui/fixtures/foundations/s24-runtime-roots-20261018.json`. Its observed Companion process directory is not an environment override: Gateway, Companion and bridge inherit the original Tier0 pin. [Claude’s review320](https://github.com/sfar-amine/samantha-core/pull/320#issuecomment-6254431719) confirms Gateway restarts before promotion and old releases are removed by retention.

Companion/Gateway helper lookup in `runtime_mode.py` and `src/runtimeRoot.ts` therefore follows `releases/current/termux-lite` by default, preserving the symlink spelling rather than resolving/caching a specific release. An inherited `CLAW_RUNTIME_ROOT`, including a stale or relative value, does not override these helper paths. Existing explicit per-helper overrides retain their caller contract. `lib.sh` and the real Tier0 daemons deliberately keep their pinned root and its absolute-path validation. No bridge environment, command override, lock descriptor or process is rewritten; environment sanitationD remains separate. No LiveVoiceSession, relay behavior, token-helper implementation or payment execution is changed.

`runtime-sync.sh --check` now compares the web capability's `BUDGET_MS` in the selected playbooks checkout with both existing core copies (`runWeb.ts`, `model-fast-path.py`). It inspects AST/constants without importing the playbooks code. Missing or malformed sources, changed budgets or a missing/different app voice-contract copy produce named drift. The core workflow also fetches the public capability source at an exact GitHub main SHA, prints that SHA, and runs the same web comparison; its CI proof therefore identifies the peer revision. No peer Python code is imported or executed. Total and search budgets are the already merged30s and12s values; this correction does not change them.

The voice fixture declares correlation values and the fatal-unknown rule, checked on every S24 parity run. The app counterpart is a JVM **test resource**, not a file deployed in the APK. As confirmed by Claude in [PR189](https://github.com/sfar-amine/samantha-ui-playbooks/pull/189#issuecomment-6248458200), app/Companion byte parity belongs to off-device CI on their two source lines. Claude owns that app-copy and Kotlin-test follow-up after this runtime PR.

On the S24, `RUNTIME_SYNC_APP_CONTRACT` requests comparison with an explicitly supplied existing app-owned copy. If unset, only the app-copy comparison is not requested: runtime voice-contract validation and web budget comparison remain active. If set but empty, missing or byte-different, it produces named drift. There is no guessed Android path under the runtime checkout, no app source falsely reported as deployed, and no new runtime copy/store. The program63 clarification is delivered separately in its owning playbooks repository.

Tests cover owner-budget mutation, app absence, byte drift, a new correlation without a matching copy, nonexecution of source under inspection and unchanged caller environment. Synthetic files exercise the real modelFastPath/model-fast-path/gemini-request helper consumers loaded before promotion, followed by current-link changes and six promotions with the old pinned release deleted. A previously returned helper path still reaches the new release. The pinned Tier0 shell owner and its relative-path refusal remain covered separately. They are registered in the existing CI. The existing runtime-sync suite still exercises gateway readiness and promotion ordering. No new HTTP route/capability is exposed.

Runtime acceptance and deployment stay with Claude. Codex Cloud received `device_timeout` twice on context reads; no S24 effect was issued. Synthetic promotion/retention regression is covered; five real S24 deployments and live parity receipts are **not tested** by this source PR. Revert this PR to restore previous helper selection/check behavior; no data migration, secret, scheduler or payment-state change is involved. Environment sanitation D remains unapproved.

## Couverture de la mémoire — complément F1 du 18/10

Le producteur `context_memory.py` possède `COVERAGE_COMPLETE` et la transition nommée
`COVERAGE_COMPLETE_LEGACY`. La copie de `tools/request_context.py` (playbooks #197, main `35108646`) est comparée par AST par le même
`contract_drift`, sans exécution du lecteur et sans lecture de données privées. Les dérives sont
`context:coverage_index_contract`, `context:coverage_legacy_contract` ou `context:coverage_contract_unavailable`.
Le workflow F1 récupère aussi le vrai lecteur au SHA exact de main, déjà journalisé pour la parité des budgets.

Le lecteur playbooks #197 est fusionné et activé ; sa vraie copie main est maintenant la référence de CI.
La complétude concerne les index, pas la lecture intégrale des contraintes. Le consommateur doit récupérer les sources
EVT/REQ avant application. `BLOCKED`, une déclaration inconnue ou contradictoire continue de fermer la barrière.
