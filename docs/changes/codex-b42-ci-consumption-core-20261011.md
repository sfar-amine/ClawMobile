# CI — limiter les déclenchements doublons

Le push déclenche la suite runtime uniquement sur runtime/samantha-companion-private. Les pull requests restent toujours contrôlées ; main et les branches feature ne déclenchent plus une deuxième suite runtime.

La concurrence est groupée par workflow et numéro de PR (ou ref pour push/dispatch), avec cancel-in-progress. Le bloc jobs est conservé octet pour octet : aucune étape de test, configuration ou signature retirée. Aucune clé ni signature exécutée par Codex. La suite locale complète de cette tête reste en attente avant readiness.

Aucun effet runtime, route/capability ou store. Retour arrière : revert de la PR ; revue et fusion par Claude. GitHub Actions reste bloqué par quota ; cette PR prépare les prochains déclenchements.
