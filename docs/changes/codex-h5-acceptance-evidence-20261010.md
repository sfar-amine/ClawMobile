# H5 — conserver les preuves de recette R6, R7 et R12

Les lectures et la garde owner sont déjà dans la recette canonique. Cette préparation ajoute un test de couverture qui relie leurs budgets aux captures HTTP réelles du S24, sans dupliquer les budgets ni modifier les routes.

Le test est inscrit dans la CI ; l'étape R6 existante vérifie toujours le refus owner. La PR #70 de replay HTTP reste en attente de fusion. Aucun déploiement ni qualification physique nouvelle n'est annoncé.
