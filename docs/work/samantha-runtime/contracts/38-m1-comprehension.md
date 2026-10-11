# 38 M1 — Compréhension dans Contrôle › Santé

Programme 38 § 3.4 et § 4 (M1). Route existante `GET /v1/control/health?contract=2` (budget 2 s, ligne de recette
existante dans `companion-acceptance.py`) : champ ajouté `sections.health.data.comprehension`, inclus dans la
`dataRevision` de la section. Aucune nouvelle route, aucun appel Gateway, aucun store.

Source : reçus de runs existants (`~/.openclaw/clawmobile-companion/runs.json`, confirmé sur le S24 le 11/10 :
25 runs, décisions v2 sur 9 d'entre eux), lus par `runs.ts` (`comprehensionRunFacts`, aucun texte).

| Champ (par fenêtre `24h`, `7d`) | Définition |
|---|---|
| `runs`, `decidedRuns`, `agentRuns` | runs acceptés dans la fenêtre ; avec décision v2 ; partis à l'agent sans décision |
| `clarify`, `clarifyRate` | décisions CLARIFY / runs décidés |
| `notThis`, `notThisRate` | runs décidés marqués « Ce n'est pas ça » (trace `notThis` d'A2) / runs décidés |
| `learnedDirect`, `learnedDirectRate` | EXECUTE résolues par une association apprise (`decision.plan.learned_association`) / runs décidés |
| `clarificationAnswers` | réponses à une question (run lié à une clarification) |
| `complete` | faux si le registre est à son plafond (500 runs) et que son plus vieux run est plus récent que le début de la fenêtre |

`status` : `unknown` sans run décidé sur 7 jours, `attention` si une transaction a été corrigée sur 7 jours
(`transaction_corrected`) ou si plus de 30 % des runs décidés sur 7 jours ont posé une question
(`clarify_rate_above_30pct`), sinon `healthy`. `descriptions` fr/en fermées ; aucun texte d'utilisateur.

Limites : `learnedDirect` reste à 0 tant que la décision v2 ne transporte pas `plan.learned_association` (ajout prévu
côté playbooks, PR M1 playbooks) ; la rétention de `runs.json` (500 runs au plus) borne la fenêtre de 7 jours, signalée
par `complete`. L'écran app (C3) reste à faire.
