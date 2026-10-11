# F3 — localisation de présentation, reprise fraîche

Les réponses serveur existantes choisissent FR/EN via Accept-Language, sans modifier codes, contenus utilisateur ou cache propriétaire. Fixtures S24 santé/automatisations conservées ; propriétaire `conditionalRead` testé sur corps localisé stable (même langue304, autre langue200/ETag distinct), sans figer l’horloge ou ajouter un cache. Une enveloppe live peut changer sa fraîcheur et rester200 normalement.

Base runtime3298d98d fusionnée normalement. Les anciennes preuves34/34 sont historiques, **nouveaux ciblés/build et suite entière pending** jusqu'au créneau lot3 libéré. Toutes les étapes CI demeurent présentes. Le signal de langue app existe désormais dans core#169 sourcebbb03c3 ; APK signé/installé, consommation intégrée des champs et recette FR/EN restent à qualifier avec Claude/Amine. Aucun changement paiement, nouvelle route, store, merge de PR ou déploiement par Codex.
