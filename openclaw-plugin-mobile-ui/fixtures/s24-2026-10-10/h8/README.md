# H8 — captures nettoyées S24

Capture Codex via Claw, exclusivement en lecture : action `codex-h8-source-metadata-20261011`, étapes `readonly-source-hashes` et `read-acceptance-receipts`. Aucune recette, notification ni modification S24 effectuée.

- `installed-source-metadata.json` : présence et SHA256 des scripts installés (deployment, acceptance, incident, health verdict), identiques à la base core bfa210c ; présence du verrou deployment. Aucune identité ou variable d'environnement.
- `acceptance-receipts.json` : deux reçus de déploiement réels, 44 contrôles chacun. Liste fermée route/code/status/seconds/budget/leak/settled/read ; aucune réponse HTTP, avertissement libre, donnée de compte, note ou stderr. Les routes sont limitées à la liste publique de la recette installée.

Il n'existe pas encore de reçu nightly produit par H8 installé. Les nuits multiples, dates et dérives des tests sont des transformations explicites des formes capturées pour tester les bornes ; aucune fixture fictive n'est présentée comme une capture runtime.
