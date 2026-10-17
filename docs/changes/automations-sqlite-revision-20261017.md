# Automatisations : révision SQLite (R5-bis) et chauffe des lectures à cache court (17/10/2026)

Bascule SAM-MIG V2.2, étape B-11 : le déploiement de `4a82a751` a été annulé automatiquement (`companion-20261017T040904`, `rolled_back`, `acceptance_failed`).
- `/control/automations?contract=2` : 4,48 s pour un budget d'1 s.
- `/learning/associations?limit=20` : 0,75 s pour un budget de 0,5 s.

Mesure sur le S24 : 4,0 s puis 0,01 s pour la première route, 0,43 s puis 0,008 s pour la seconde. Le défaut est antérieur à V2.2 : la révision du chemin rapide lisait `~/.openclaw/cron/jobs.json`, absent du S24 (OpenClaw stocke dans `state/openclaw.sqlite`), si bien que chaque lecture à froid relançait la collecte complète.

## Changements
- **#78 (R5-bis) reprise sur la base actuelle.** La révision des automatisations vient du propriétaire reporting des playbooks épinglés (`--automation-revision`, playbooks #38 épinglée, `7b6cabed`). Le timeout du probe passe de 200 à 600 ms ; 600 + 80 ms restent sous le budget d'1 s, inchangé.
- **`companion-acceptance.py`.** `PREWARM` fait une lecture non chronométrée juste avant la ligne chronométrée de ces deux routes, comme `/catalog` le fait déjà. Ces deux routes ont un cache plus court que `RETRY_PAUSE_S` (8 s), donc leur relance était froide elle aussi.
  - Les budgets ne changent pas.
  - Une chauffe qui échoue fait échouer la recette.

## Tests
- `test-companion-acceptance-settle.py::test_short_cache_reads_are_prewarmed_untimed` (déjà dans `ci.yml`).
- `test-control-automations-latency.cjs` (#78, déjà dans `ci.yml`).

## Capability et architecture
Aucune capability ni route nouvelle. Le propriétaire existant est réutilisé (reporting `read_db`) ; aucun nouveau store.

## Retour arrière
Revert de ce commit de fusion ; aucun état runtime.
