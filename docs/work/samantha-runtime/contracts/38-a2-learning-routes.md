# 38 A2 — routes Companion d'apprentissage

Contrat complet (forme JSON, vues app HA6, effets) : `samantha-ui-playbooks`
`docs/work/samantha-runtime/contracts/38-a2-learning-routes.md` (PR playbooks A2 #78, alignée sur A1 #76 fusionnée).

| Route | Capability | Budget | Garde |
|---|---|---|---|
| `GET /v1/learning/associations?offset&limit&view` | `samantha.app.learning.list` (read_only) | 500 ms | loopback natif, sans en-têtes navigateur |
| `POST /v1/learning/associations/{id}/forget` `{operationId}` | `samantha.app.learning.forget` (write) | 3 s | + `x-clawmobile-owner-flow: v1` |
| `POST /v1/learning/not-this` `{runId, operationId}` | `samantha.app.learning.not_this` (write) | 3 s | + `x-clawmobile-owner-flow: v1` |

Aucune route `approve` (D1 : apprentissage autonome après run vérifié, pas de « Retenir »).

## Chemin

`learning.ts` appelle `python3 -m reporting.control_learning` du playbooks épinglé (`controlPaths().playbooks`), avec
`SAMANTHA_IMPROVEMENT_STORE` (défaut `~/.openclaw/skill-intelligence/improvements.db`, confirmé sur le S24 le 11/10 :
tables `improvement_candidates` / `improvement_history`, 0 association). Le propriétaire est `engineering.learning_gate`
(A1) ; aucun store, routeur ni démon côté Companion. Une lecture par page ; cache 5 s invalidé par la signature
(inode, taille, mtime) du store et de son WAL ; rejeu `forget` par `operationId` (64 entrées au plus).

`not-this` lit le run dans le registre existant `runs.json` (texte, décision v2), transmet texte et décision au
propriétaire (neutralisation du binding résolu du gabarit, contre-exemple, signal Round Learning
`user_correction`), puis pose sur le run
une trace bornée `notThis {version, operationId, at, neutralized, counterExample, roundSignal}` — sans texte ni montant.
Un second appel répond `already_recorded` sans rappeler le propriétaire. La réponse ne contient ni texte, ni gabarit,
ni décision. Le parcours de paiement n'est pas touché.

## Recette et retour arrière

`companion-acceptance.py` : lecture `/learning/associations?limit=20` à 0,5 s ; `forget` et `not-this` refusés sans
en-tête propriétaire. Retour arrière : revert de la PR ; la trace `notThis` est ignorée par les versions précédentes
(champ non lu).
