# F1 — Runtime roots and shared contract parity (18 October 2026)

Tier0 exports a **termux-lite directory**, not a repository. Claude's sanitized S24 observation is recorded in `openclaw-plugin-mobile-ui/fixtures/foundations/s24-runtime-roots-20261018.json`: supervisors intentionally run the pinned release, while the Companion runs its checkout. The shared shell/Python/TypeScript readers respect each process's `CLAW_RUNTIME_ROOT`; no bridge environment, command override, lock descriptor or process is rewritten. Relative roots fail explicitly instead of following the working directory. Tier0 remains the owner of the current-release link.

`lib.sh`, `runtime_mode.py` and `src/runtimeRoot.ts` own root interpretation. Existing explicit helper overrides remain prior choices. Token-helper lookup changes only its root resolution; LiveVoiceSession, relay protocol behavior and payment execution are outside this change. The Common root helper is reused by existing native/read helpers, never a new router or store.

`runtime-sync.sh --check` now compares the web capability's `BUDGET_MS` in the selected playbooks checkout with both existing core copies (`runWeb.ts`, `model-fast-path.py`). It inspects AST/constants without importing the playbooks code. Missing or malformed sources, changed budgets or a missing/different app voice-contract copy produce named drift. The core workflow also fetches the public capability source at an exact GitHub main SHA, prints that SHA, and runs the same web comparison; its CI proof therefore identifies the peer revision. No peer Python code is imported or executed. Total and search budgets remain 20 s and 12 s; this PR does not change them.

The voice fixture declares correlation values and the fatal-unknown rule, checked on every S24 parity run. The app counterpart is a JVM **test resource**, not a file deployed in the APK. As confirmed by Claude in [PR189](https://github.com/sfar-amine/samantha-ui-playbooks/pull/189#issuecomment-6248458200), app/Companion byte parity belongs to off-device CI on their two source lines. Claude owns that app-copy and Kotlin-test follow-up after this runtime PR.

On the S24, `RUNTIME_SYNC_APP_CONTRACT` requests comparison with an explicitly supplied existing app-owned copy. If unset, only the app-copy comparison is not requested: runtime voice-contract validation and web budget comparison remain active. If set but empty, missing or byte-different, it produces named drift. There is no guessed Android path under the runtime checkout, no app source falsely reported as deployed, and no new runtime copy/store. The program63 clarification is delivered separately in its owning playbooks repository.

Tests cover owner-budget mutation, app absence, byte drift, a new correlation without a matching copy, nonexecution of source under inspection, distinct S24-observed roots, relative-root refusal and unchanged caller environment. They are registered in the existing CI. The existing runtime-sync suite still exercises gateway readiness and promotion ordering. No new HTTP route/capability is exposed.

Runtime acceptance and deployment stay with Claude. Codex Cloud received `device_timeout` twice on context reads; no S24 effect was issued. Five-deployment and live parity receipts are **not tested** by this source PR. Revert this PR to restore previous helper selection/check behavior; no data migration, secret, scheduler or payment-state change is involved. Environment sanitation D remains unapproved.

## Couverture de la mémoire — complément F1 du 18/10

Le producteur `context_memory.py` possède `COVERAGE_INDEX_COMPLETE` et la transition nommée
`COVERAGE_LEGACY_COMPLETE`. La copie de `tools/request_context.py` (playbooks #198) est comparée par AST par le même
`contract_drift`, sans exécution du lecteur et sans lecture de données privées. Les dérives sont
`context:coverage_index_contract`, `context:coverage_legacy_contract` ou `context:coverage_contract_unavailable`.
Le workflow F1 récupère aussi le vrai lecteur au SHA exact de main, déjà journalisé pour la parité des budgets.

Ordre : fusion et activation du lecteur playbooks #198 d'abord ; cette contrepartie core attend main pour sa CI.
La complétude concerne les index, pas la lecture intégrale des contraintes. Le consommateur doit récupérer les sources
EVT/REQ avant application. `BLOCKED`, une déclaration inconnue ou contradictoire continue de fermer la barrière.
