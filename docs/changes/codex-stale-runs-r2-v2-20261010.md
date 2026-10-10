# R2-v2 — preuve d’inactivité et résultat tardif

Un run ne peut plus expirer du seul fait de son âge ou de l’absence de sessions.json. Le Gateway propriétaire apporte la trajectoire, l’état d’activité et les approbations. Sans preuve explicite, le run reste inchangé. Un outil sans résultat protège le run ; les gardes de paiement/confirmation sont exclues avant lecture de transcript, sans confiance dans origin.id.

Un résultat réel tardif ou une reprise d’activité corrige l’expiration avec un reçu dans le run existant. Le callback final, les lectures de statut et les listes peuvent porter la correction. Les écritures passent par le verrou existant et revalident les suppressions, archives, décisions et gardes. Le chemin des résumés ordinaires reste sans Gateway. Le contrat r3 précise la réutilisation d’un nouvel operationId non enregistré lors d’une re-suppression.

Validation : build TypeScript ; quatre non-régressions du fichier 09, fixture propriétaire SQLite, correction via lecture explicite de conversation/callback et redémarrage ; courses suppression/archive/résultat/échec/garde ; trace-induction, R1, R3, R4, cache, pagination, backfill, soumission ; paiement 58/58. CI préserve toutes les étapes existantes et ajoute les suites R2.

Architecture et MCP inchangés : aucun propriétaire supplémentaire, aucun store/scheduler/daemon. Contrat : docs/work/samantha-runtime/contracts/r2.md. Git uniquement ; Claude relit, fusionne et recette sur S24. L’exposition effective des preuves Gateway reste à qualifier sur l’appareil. Retour arrière : revert du commit ; les reçus additifs sont ignorés par l’ancien lecteur.

Relecture 17 remplace le budget de lecture initial : voir le contrat r2 pour la passe en arrière-plan sous 10 s.

Relecture 17 M1/M2 corrigée : réconciliation single-flight en arrière-plan sous 10 s, état courant rendu immédiatement, preuve nommant le run pour la remise en running, expirations retirées du pool automatique. Les quatre tests requis et les contrôles CI locaux passent ; la recette S24 reste à Claude.

Base 286fdd3 intégrée. Le repli par preuve de tour est testé avec un id Gateway différent ; la lecture explicite de conversation peut corriger l’expiration d’un outil encore actif.
