# C8 — Guardian lit SQLite en lecture seule, parité avec la commande historique

Contrat : docs/work/samantha-runtime/contracts/c8.md. Le Guardian lit `session_nodes.entry_json` du store `main` en `mode=ro`, sans `openclaw sessions --json` ni Node.

La fenêtre de contexte suit la règle installée d'OpenClaw 2026.9.6 (#131) : fenêtre stockée seulement si elle est fiable pour sa sélection, sinon 200 000. Sur les 87 lignes réelles jointes au CLI, `contextTokens`, `totalTokens` et `kind` sont identiques ligne à ligne, avec 3 sessions ≥ 60 % et 3 ≥ 80 %. 13 tests SQLite/shell dans la CI. Mesure physique après déploiement : recette de Claude (avant : 9,7 s puis 2,9 s pour la seule commande CLI).
