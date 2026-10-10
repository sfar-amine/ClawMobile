# P2-a — détail et actions d'une automatisation

Base locale : runtime/samantha-companion-private da19e89 après PR #9, puis R5, V2 et V4. Aucun nouveau store, scheduler, registry ou daemon. Les lectures et effets passent par le Gateway OpenClaw et son scheduler existant.

GET /v1/automations/{id} : schemaVersion=1, id, what (description ou nom humain filtré, jamais le prompt), enabled, nextRunAt ISO ou null, runs[] (10 derniers, at ISO/null, status ok|error|skipped|unknown, note filtrée/null), actions[]. cron.list inclut les jobs désactivés ; une liste partielle est refusée, jamais présentée comme exhaustive. cron.runs fournit l'historique ; une absence de source produit 503.

POST /v1/automations/{id}/enable|disable|run et DELETE /v1/automations/{id}, corps strict {operationId}. Loopback natif, sans Origin/Referer/sec-fetch-site ; les mutations demandent x-clawmobile-owner-flow: v1. Aucun shell ou payload éditable n'est accepté.

Les effets sont réservés via reserveSubmittedRun dans le registre de runs existant. L'identité lie operationId, action et cible. Le reçu est stocké dans le résultat du run par settleSubmittedRun et relu sur disque avant publication. Aucun second journal d'idempotence. Un retry rend le reçu persistant ; une autre intention sur le même operationId est refusée. La fenêtre de rétention est celle du registre existant (500 runs) et de ses tombstones ; les IDs d'opération doivent rester uniques, même après cette fenêtre. Ne pas réutiliser un ancien ID sorti de cette rétention.

Réponse {success,state,receipt}. enable/disable/delete sont completed après lecture de confirmation du scheduler. run est accepted après confirmation de dispatch : ce reçu ne prétend pas que le job est terminé. Une concurrence encore active ou un effet non vérifiable est indeterminate ; aucun rejeu automatique. Rechercher le résultat avec la même intention, sans changer operationId.

Les jobs liés à paiement, banque, biométrie ou confirmation sont non actionnables : actions vide, mutation blocked/409 avant toute écriture scheduler. Les registres de paiement et confirmation restent inchangés. Une indisponibilité ne libère jamais cette garde.

Contrat testé hors ligne : détail et dix runs, redaction, owner/browser boundary, erreurs de corps et d'encodage, conflits, concurrence, suppression/retry, redémarrage, dispatch incertain sans rejeu, gardes financières et conservation des données paiement. Les RPC cron.list/cron.runs/cron.update/cron.run/cron.remove et le reçu doivent être qualifiés par Claude sur S24 avant activation ; aucun reçu S24 revendiqué par les fixtures. Retour arrière : revert du lot.
