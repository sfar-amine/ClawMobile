# H5 — conserver les preuves de recette R6, R7 et R12

Les lectures et la garde owner sont déjà dans la recette canonique. Cette préparation ajoute un test de couverture qui relie leurs budgets aux captures HTTP réelles du S24, sans dupliquer les budgets ni modifier les routes.

Le test est inscrit dans la CI ; l'étape R6 existante vérifie toujours le refus owner. La PR #70 de replay HTTP reste en attente de fusion. Aucun déploiement ni qualification physique nouvelle n'est annoncé.

Reprise Claude (11/10) : ajout des 10 derniers reçus de déploiement réels du S24 (`c1ff5e7` → `fe5e5b1`), lus en lecture seule. Les trois lectures restent dans leur budget et la garde POST R6 refuse à chaque déploiement. `/agent/config` a atteint 85 % de son budget sur `f95be8d` : tâche d'optimisation, budget inchangé.

Reprise42 : base `91060b54` ; build, H5 7/7, R6 et F6 verts. Correctif partagé F6 conserve l’incertitude à la borne de processus sans augmenter budget/borne ; ciblé 17 abandons,479ms, overflow4097 unknown. Preuve `h5-lot3-targeted.log`. Publication conditionnée par la CI entière verte au SHA exact.
