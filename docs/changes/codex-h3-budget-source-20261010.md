# H3 — Rapport runtime déplacé et source de budgets explicite

Le rapport lit la table canonique par AST au début de l'exécution, après parsing CLI. `--acceptance` permet de préciser son emplacement ; une source absente donne `budget_source_missing` dans le reçu sans traceback ni chemin privé. Aucun code de la source n'est exécuté.

Budgets et marge G2 inchangés, politique e-mail de la recette conservée. 13 tests G2 et 8 tests H3 réussis ; nouvelles vérifications inscrites dans la CI existante. Capture réelle PR #82 utilisée pour vérifier la conservation des budgets. [Contrat H3](../work/samantha-runtime/contracts/h3.md).
