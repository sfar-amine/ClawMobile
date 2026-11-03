# Outil typé `samantha_qa` côté plugin — 2 novembre 2026

Décision d'Amine du 02/11 : construire l'outil QA, ne pas fermer la pièce. Règle « le cerveau partout » (samantha-ui-playbooks `docs/08-decisions/ADR-20261102-brain-everywhere.md`, annexe §8 étape 8.5).

## Constat (S24, lecture seule, 02/11)

Le catalogue compilé `~/.openclaw/capability-views/agent-tools.json` (révision `1e0476abc173fceb`) contient 13 outils typés ; la ligne `qa.test_campaign` n'a aucun appel typé. En mode cerveau seul, le cerveau n'avait aucune action QA.

## Changement

- `openclaw.plugin.json` : `samantha_qa` dans `contracts.tools`. Sans cette déclaration, la Gateway refuse un outil de plugin non déclaré et perd tout le lot typé (incident du 31/10 avec `samantha_device_assistance`).
- Aucun changement de `typedCapabilityTools.ts` ni de `capabilityAgentGuard.ts` : la fabrique projette l'outil depuis le catalogue compilé par les playbooks (samantha-ui-playbooks, branche `claude/samantha-qa`, skill `qa`, propriétaire `qa_testing/typed_qa.py`). `samantha_qa` reste **hors** `DIRECT_TYPED_TOOLS` : outil rare, trouvé par la recherche d'outils, sans coût sur la surface directe du prompt.
- Les quatre écritures (`qa.campaign.start`, `qa.plan.approve`, `qa.map.approve`, `qa.campaign.cancel`) portent « récapitulatif puis confirmation » ; les cinq lectures s'exécutent directement. `confirm` ne transmet que `confirmationId` et `payloadHash`.
- Contacts et pièces : la fabrique ne sert que `main` propriétaire ; le crochet refuse `samantha_qa` pour un agent `contacts-qa` et pour une pièce Pulse (`PULSE_ROOM_TOOLS` reste `samantha_pulse`).

| Route | Budget | Capability |
|---|---|---|
| Aucune nouvelle route Companion | — | `qa.test_campaign` (outil typé `samantha_qa`, déclaré dans samantha-ui-playbooks) |

## Test

`openclaw-plugin-mobile-ui/scripts/test-typed-qa-tool.cjs`, inscrit dans `.github/workflows/ci.yml` (étape « Verify host-bound capability owner admission (P1) »). Il n'ouvre ni Gateway ni Companion : un helper Python factice enregistre les commandes reçues.

## Fixtures

`openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-qa-typed-tool/` : résumé du catalogue compilé capturé en lecture seule sur le S24 (empreinte `90f18551…`) et projection source de `samantha_qa` (commit playbooks indiqué). Voir `README.md` et `provenance.json`.

## Suite : pièce QA d'un contact

Après fusion de core #529 et playbooks #387 (`roomBrain.ts`, `ROOM_DOMAINS`, refus `room_domain_not_typed`) : faire correspondre la pièce `qa` au domaine typé `qa` (`samantha_qa`), avec relecture du droit QA (`people-trusted.py qa_scope_read`, `qaApps`) à chaque message et avant chaque écriture, et la portée privée QA existante liée à l'application accordée. Les lectures d'abord ; le démarrage d'une campagne de l'app accordée seulement si `allow_writes` ; jamais d'approbation de plan ou de carte, ni de campagne à paiement.

## Retour arrière

Revert du commit puis redéploiement du commit Companion précédent par `companion-deploy.sh`. Si les playbooks avec `samantha_qa` restent activés après ce retour arrière, revenir aussi aux playbooks précédents (`activate-ui-playbooks.sh <sha>`) : un outil non déclaré ferait refuser le lot typé par la Gateway.
