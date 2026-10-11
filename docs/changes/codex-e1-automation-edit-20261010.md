# E1 / R23 — modifier une automatisation

`PATCH /v1/automations/{id}` modifie le nom, la planification, la consigne (`agentTurn`) ou l'activation, via le propriétaire existant `cron.update`. [Contrat](../work/samantha-runtime/contracts/r23.md).

- Refus paiement (422) et validation (400) avant toute lecture ; automatisation protégée : 409 `automation_protected`.
- CAS : `If-Match` = `configRevision` natif (exposé en `revision` par `GET /v1/automations/{id}`), transmis comme `expectedConfigRevision` ; conflit : 409.
- Consigne ou planification d'un `agentTurn` : 403 `needs_confirmation` `{scope:"automation.edit", reference:id, payloadHash}`, puis consommation de la confirmation biométrique.
- Reçu natif, une seule écriture, une relecture après effet incertain, jamais de rejeu.

Fixtures : captures #131 (`s24-2026-10-11b/e1/`) et lecture seule du schéma installé (`s24-2026-10-11-r34/e1/`).
Limite : le prédicat actuel protège toutes les automatisations du S24 ; correction chez son propriétaire, en PR séparée.
