# R4 Companion — conserver les résultats des lectures composées

Le resolver canonique est livré séparément dans samantha-ui-playbooks. Cette adaptation n’ajoute aucune classification métier : elle présente les résultats canoniques `composed_read` par opérateur, conserve les données reçues lors d’un succès partiel et distingue incertitude et absence de dispatch. `known_error` reste terminal en échec, avec `execution_state` et `result` ; aucun succès complet ou total inventé.

Les consultations simples et le paiement conservent leur présentation. Aucun endpoint, store, registry, scheduler ni retry. Base runtime/samantha-companion-private 177edca, indépendamment de M1 PR #1 et des lots R1–R3.

Contrat C15 dans doc27. Build, 5 tests de présentation, fast-path, durable, trace-induction et 58 tests payment-core passent. La CI rejoue la présentation et les fast paths. Les tests sont hors ligne, sans lecture ou déploiement S24. Le fixture fast-path utilise désormais le répertoire temporaire natif au lieu du HOME (lecture seule dans Codex Cloud).

Dépendance : intégrer aussi R4 canonique avant recette. Claude porte la relecture, la qualification Android/S24, le reçu live et l’activation. Préserver les sections C12/C13/C14 lors de l’intégration des PRs indépendantes. Rollback : revert de ce commit, sans migration persistante.
