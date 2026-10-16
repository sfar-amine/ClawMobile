# R14 — description du cron du curateur mémoire

La capture S24 du 13/10 montre que le propriétaire existant `claw:cross-surface-memory-curator` s'exécute bien à 22:10 `Africa/Tunis` et produit toujours `mode: shadow`. Sa description affirme toutefois encore qu'il suit une promotion dreaming native à 13:00, alors que ce dreaming a été désactivé le 12/10 par décision d'Amine.

`reconcile-memory-curator-cron.py` sélectionne cet unique propriétaire par `declarationKey`, vérifie son horaire, sa commande et son activation, puis prépare uniquement le remplacement de la description. Sans `--apply`, il ne modifie rien. Avec `--apply`, il utilise `openclaw cron edit --description`, relit le job et refuse la clôture si son contrat stable a changé.

La nouvelle description indique l'horaire 22:10, le maintien en mode shadow, le dreaming natif désactivé et la condition M5 non régressive avant toute sortie du shadow. Le script ne modifie ni l'horaire, ni la commande, ni le mode du curateur. Claude applique la réconciliation après fusion et vérifie le reçu du passage suivant.

Retour arrière : réappliquer l'ancienne description avec `openclaw cron edit <id> --description <ancienne-description>`. Aucun état mémoire ni événement n'est modifié.
